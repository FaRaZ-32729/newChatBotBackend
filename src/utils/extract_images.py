"""
extract_images.py

Extracts embedded images from a PDF and names each one from the most
relevant nearby title/caption (prefer text BELOW the image, then above,
then left/right) — not from a global heading stream alone.

Strategies (in order):
  1) Per-image proximity caption (primary — fixes "title under photo" layouts)
  2) Quality-checked TOC / bookmarks (only if TOC looks like real headings)
  3) Font-size heading heuristic as page-level fallback

Requires: pip install PyMuPDF

Usage:
    python3 extract_images.py <pdf_path> <output_dir>
"""

import fitz  # PyMuPDF
import sys
import json
import os
import re
from collections import Counter, defaultdict

BOLD_FLAG = 1 << 4
FULL_WIDTH_RATIO = 0.65
MIN_COLUMN_GAP = 15

# Skip decorative / tiny embeds
MIN_IMAGE_WIDTH = 40
MIN_IMAGE_HEIGHT = 40
MIN_IMAGE_AREA = 2500

# Caption search
MAX_CAPTION_CHARS = 90
MAX_BELOW_GAP = 120   # pts below image bottom
MAX_ABOVE_GAP = 80    # pts above image top
MAX_SIDE_GAP = 60

EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
PHONE_RE = re.compile(r"(?:\+?\d[\d\s().-]{6,}\d)")
URL_RE = re.compile(r"(https?://|www\.)", re.I)
BULLET_RE = re.compile(r"^[\s●•▪◦\-–—*]+")
ROLE_RE = re.compile(
    r"\b(CEO|CTO|COO|CFO|CMO|Founder|Director|Manager|Officer|Engineer|"
    r"Lead|Head|President|Chairman|Partner|Consultant)\b",
    re.I,
)
BIO_START_RE = re.compile(
    r"\b(is an?|is the|are an?|has a|has an|leads|specializes|works|focuses)\b",
    re.I,
)


def slugify(text, maxlen=50):
    text = re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_")
    return text[:maxlen] or "image"


def is_junk_heading(text):
    """Filter emails, phones, bullets, expertise lists, etc."""
    t = (text or "").strip()
    if not t or len(t) < 3:
        return True
    if EMAIL_RE.search(t) or PHONE_RE.search(t) or URL_RE.search(t):
        return True
    if re.search(r"\b(email|number|phone|mobile|tel)\s*:", t, re.I):
        return True
    if BULLET_RE.match(t) or t.count("●") >= 2:
        return True
    if len(t) > 160:
        return True
    # Pure expertise list lines
    if t.lower() in {"areas of expertise", "expertise", "skills", "contact"}:
        return False  # valid section label, but weak as image name alone
    return False


def extract_title_from_block(text):
    """
    From a mixed title+bio block, pull the short title portion.
    Example:
      'Muhammad Jawwad Malik, Chief Executive Officer (CEO) Muhammad ... is a ...'
      -> 'Muhammad Jawwad Malik, Chief Executive Officer (CEO)'
    """
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return ""

    # Prefer first line if multi-line and short
    first_line = t.split("\n")[0].strip()
    if 3 <= len(first_line) <= MAX_CAPTION_CHARS and not is_junk_heading(first_line):
        # If first line still has bio glued on, keep refining below
        t = first_line

    # "Title: long explanation" → keep Title
    if ":" in t:
        left, right = t.split(":", 1)
        left = left.strip()
        if 3 <= len(left) <= 60 and not left.lower().startswith(("email", "phone", "http")):
            t = left

    # Cut at bio start ("is a", "leads", ...)
    m = BIO_START_RE.search(t)
    if m and m.start() > 12:
        candidate = t[: m.start()].strip(" ,.-")
        if 3 <= len(candidate) <= MAX_CAPTION_CHARS + 20:
            t = candidate

    # Name, Role (CEO) pattern — stop after closing paren of role if bio continues
    role_m = ROLE_RE.search(t)
    if role_m:
        after = t[role_m.end() :]
        # If text continues with another capitalized name (bio restart), cut there
        cont = re.search(r"\)\s+[A-Z][a-z]+", after)
        if cont:
            t = t[: role_m.end() + cont.start() + 1].strip()
        else:
            # Cut at first period after role if long
            period = t.find(".", role_m.end())
            if period != -1 and period < len(t) - 1:
                t = t[:period].strip()

    # First sentence if still long
    if len(t) > MAX_CAPTION_CHARS:
        period = t.find(".")
        if 10 <= period <= MAX_CAPTION_CHARS + 30:
            t = t[:period].strip()
        else:
            t = t[:MAX_CAPTION_CHARS].rsplit(" ", 1)[0].strip()

    t = t.strip(" ,.-")
    if is_junk_heading(t) and not ROLE_RE.search(t):
        return ""
    return t


def get_body_font_size(doc):
    counter = Counter()
    for page in doc:
        d = page.get_text("dict")
        for block in d["blocks"]:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    size = round(span["size"], 1)
                    counter[size] += len(span["text"])
    if not counter:
        return 10.0
    return counter.most_common(1)[0][0]


def collect_text_blocks(page, body_size):
    """Return list of text blocks with geometry + style for caption scoring."""
    d = page.get_text("dict")
    blocks = []
    for block in d["blocks"]:
        if block["type"] != 0:
            continue
        parts = []
        max_size = 0
        is_bold = False
        for line in block["lines"]:
            line_parts = []
            for span in line["spans"]:
                line_parts.append(span["text"])
                size = round(span["size"], 1)
                if size > max_size:
                    max_size = size
                    is_bold = bool(span["flags"] & BOLD_FLAG)
            parts.append("".join(line_parts))
        raw = "\n".join(parts).strip()
        if not raw:
            continue
        bbox = block["bbox"]
        title = extract_title_from_block(raw)
        blocks.append({
            "raw": raw,
            "title": title,
            "bbox": bbox,
            "x0": bbox[0], "y0": bbox[1], "x1": bbox[2], "y1": bbox[3],
            "size": max_size,
            "bold": is_bold,
            "is_heading_like": max_size > body_size * 1.08 or (is_bold and max_size >= body_size),
        })
    return blocks


def horizontal_overlap(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def find_caption_for_image(image_rect, text_blocks, body_size):
    """
    Pick the best caption for an image from nearby text.
    Prefer: directly below > above > side, with bold/larger text winning.
    """
    ix0, iy0, ix1, iy1 = image_rect.x0, image_rect.y0, image_rect.x1, image_rect.y1
    i_w = max(ix1 - ix0, 1.0)
    candidates = []

    for b in text_blocks:
        title = b["title"]
        if not title:
            continue
        if is_junk_heading(title):
            continue

        weak = title.lower() in {"areas of expertise", "expertise", "skills", "contact", "about"}
        looks_like_heading = (
            b["is_heading_like"]
            or ROLE_RE.search(title)
            or (b["bold"] and len(title) <= 70)
            or (len(title) <= 45 and title[:1].isupper())
        )
        # Body paragraphs glued under images — skip unless clearly a heading
        if not looks_like_heading:
            continue
        # Mid-sentence fragments ("location, stay connected...")
        if title[:1].islower():
            continue

        overlap = horizontal_overlap(ix0, ix1, b["x0"], b["x1"])
        overlap_ratio = overlap / i_w

        if b["y0"] >= iy1 - 5:
            gap = b["y0"] - iy1
            if gap > MAX_BELOW_GAP:
                continue
            position = "below"
            pos_score = 100 - gap
        elif b["y1"] <= iy0 + 5:
            gap = iy0 - b["y1"]
            if gap > MAX_ABOVE_GAP:
                continue
            position = "above"
            pos_score = 70 - gap
        else:
            cx = (b["x0"] + b["x1"]) / 2.0
            if cx < ix0:
                gap = ix0 - b["x1"]
                position = "left"
            elif cx > ix1:
                gap = b["x0"] - ix1
                position = "right"
            else:
                continue
            if gap > MAX_SIDE_GAP:
                continue
            pos_score = 40 - gap
            overlap_ratio = max(overlap_ratio, 0.2)

        if overlap_ratio < 0.15 and position in ("below", "above"):
            continue

        style_score = 0
        if b["is_heading_like"]:
            style_score += 30
        if b["bold"]:
            style_score += 12
        if b["size"] > body_size * 1.2:
            style_score += 18
        if ROLE_RE.search(title):
            style_score += 25
        if weak:
            style_score -= 45
        if len(title) > 70:
            style_score -= 20

        length_score = max(0, 35 - abs(len(title) - 35) * 0.4)
        score = pos_score + style_score + length_score + overlap_ratio * 20
        candidates.append({
            "title": title,
            "score": score,
            "position": position,
            "raw": b["raw"],
        })

    if not candidates:
        return None

    candidates.sort(key=lambda c: c["score"], reverse=True)
    best = candidates[0]
    if best["score"] < 35:
        return None
    return best


def toc_looks_reliable(toc):
    """Reject Word-exported garbage TOCs (emails, bullets, long paragraphs)."""
    if not toc or len(toc) == 0:
        return False
    junk = 0
    for entry in toc:
        title = entry[1] if len(entry) > 1 else ""
        if is_junk_heading(title) or len(title) > 100 or BULLET_RE.match(title.strip()):
            junk += 1
        if EMAIL_RE.search(title) or PHONE_RE.search(title):
            junk += 2
    # If more than 30% junk, ignore TOC entirely
    return (junk / max(len(toc), 1)) < 0.3


def get_toc_events(doc):
    toc = doc.get_toc(simple=False)
    if not toc_looks_reliable(toc):
        return {}, False

    events_by_page = defaultdict(list)
    for entry in toc:
        lvl, title, page_num = entry[0], entry[1], entry[2]
        title = extract_title_from_block(title) or title.strip()
        if is_junk_heading(title):
            continue
        dest = entry[3] if len(entry) > 3 else None
        page_index = page_num - 1
        if page_index < 0 or page_index >= len(doc):
            continue

        page = doc[page_index]
        y_top = None
        x0 = x1 = None

        if isinstance(dest, dict):
            to_point = dest.get("to")
            if to_point is not None:
                y_top = page.rect.height - to_point.y
                x0 = to_point.x

        if y_top is None:
            rects = page.search_for(title.strip()[:60])
            if rects:
                r = rects[0]
                y_top, x0, x1 = r.y0, r.x0, r.x1

        if y_top is None:
            y_top = 0

        level = "main" if lvl == 1 else ("section" if lvl == 2 else "sub")
        events_by_page[page_index].append((y_top, level, title, x0, x1))

    return events_by_page, any(events_by_page.values())


def get_heading_size_tiers(doc, body_size):
    sizes = set()
    for page in doc:
        d = page.get_text("dict")
        for block in d["blocks"]:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    size = round(span["size"], 1)
                    is_bold = bool(span["flags"] & BOLD_FLAG)
                    if size > body_size * 1.08 or (is_bold and size >= body_size):
                        sizes.add(size)
    sizes = sorted(sizes, reverse=True)
    tiers = {}
    for i, size in enumerate(sizes):
        tiers[size] = "main" if i == 0 else ("section" if i == 1 else "sub")
    return tiers


def get_font_size_events(doc, body_size):
    tiers = get_heading_size_tiers(doc, body_size)
    events_by_page = defaultdict(list)
    for page_index in range(len(doc)):
        page = doc[page_index]
        for b in collect_text_blocks(page, body_size):
            if not b["is_heading_like"]:
                continue
            title = b["title"]
            if not title or is_junk_heading(title):
                continue
            # Skip weak labels as main stream headings unless short & bold
            if title.lower() in {"areas of expertise", "expertise"} and b["size"] <= body_size * 1.15:
                level = "section"
            else:
                level = tiers.get(b["size"], "sub")
            events_by_page[page_index].append(
                (b["y0"], level, title, b["x0"], b["x1"])
            )
    return events_by_page


def detect_page_columns(page, body_size, image_rects=None):
    d = page.get_text("dict")
    intervals = []
    for block in d["blocks"]:
        if block["type"] != 0:
            continue
        max_size = 0
        for line in block["lines"]:
            for span in line["spans"]:
                max_size = max(max_size, round(span["size"], 1))
        if max_size > body_size * 1.08:
            continue
        bbox = block["bbox"]
        intervals.append((bbox[0], bbox[2]))
    if image_rects:
        for rect in image_rects:
            intervals.append((rect.x0, rect.x1))
    if len(intervals) < 2:
        return None
    intervals.sort()
    merged = []
    for x0, x1 in intervals:
        if merged and x0 <= merged[-1][1] + 5:
            merged[-1] = (merged[-1][0], max(merged[-1][1], x1))
        else:
            merged.append([x0, x1])
    if len(merged) != 2:
        return None
    (a0, a1), (b0, b1) = merged
    gap = b0 - a1
    page_width = page.rect.width
    if gap > MIN_COLUMN_GAP and (a1 - a0) < FULL_WIDTH_RATIO * page_width \
            and (b1 - b0) < FULL_WIDTH_RATIO * page_width:
        return (a1 + b0) / 2.0
    return None


def classify_column(x0, x1, split_x, page_width):
    if split_x is None:
        return "full"
    width = (x1 - x0) if (x0 is not None and x1 is not None) else None
    if width is None:
        return "full"
    if width > FULL_WIDTH_RATIO * page_width:
        return "full"
    center = (x0 + x1) / 2.0
    return "left" if center < split_x else "right"


def order_page_events(events, split_x, page_width):
    for e in events:
        e["col"] = classify_column(e["x0"], e["x1"], split_x, page_width)
    events = sorted(events, key=lambda e: (round(e["y0"], 1), e["priority"]))
    ordered = []
    buf_left, buf_right = [], []

    def flush():
        buf_left.sort(key=lambda e: (round(e["y0"], 1), e["priority"]))
        buf_right.sort(key=lambda e: (round(e["y0"], 1), e["priority"]))
        ordered.extend(buf_left)
        ordered.extend(buf_right)
        buf_left.clear()
        buf_right.clear()

    for e in events:
        if e["col"] == "full":
            flush()
            ordered.append(e)
        elif e["col"] == "left":
            buf_left.append(e)
        else:
            buf_right.append(e)
    flush()
    return ordered


def is_usable_image(bbox, base_image):
    w = bbox.x1 - bbox.x0
    h = bbox.y1 - bbox.y0
    if w < MIN_IMAGE_WIDTH or h < MIN_IMAGE_HEIGHT or (w * h) < MIN_IMAGE_AREA:
        return False
    # Skip very thin lines / icons
    if w < 80 and h < 80 and base_image.get("width", 0) < 80:
        return False
    return True


def extract(pdf_path, output_dir):
    doc = fitz.open(pdf_path)
    os.makedirs(output_dir, exist_ok=True)

    body_size = get_body_font_size(doc)
    toc_events_by_page, has_toc = get_toc_events(doc)

    if has_toc:
        heading_events_by_page = toc_events_by_page
        heading_source = "toc"
    else:
        heading_events_by_page = get_font_size_events(doc, body_size)
        heading_source = "font-size"

    results = []
    name_counter = Counter()

    main_heading = ""
    section_heading = ""
    sub_heading = ""

    for page_index in range(len(doc)):
        page = doc[page_index]
        page_width = page.rect.width
        text_blocks = collect_text_blocks(page, body_size)

        real_images = {}
        for img in page.get_images(full=True):
            xref = img[0]
            rects = page.get_image_rects(xref)
            if not rects:
                continue
            # Prefer largest rect if multiple placements
            rect = max(rects, key=lambda r: (r.x1 - r.x0) * (r.y1 - r.y0))
            try:
                base = doc.extract_image(xref)
            except Exception:
                continue
            if not is_usable_image(rect, base):
                continue
            real_images[xref] = (rect, base)

        split_x = detect_page_columns(
            page, body_size, [r for r, _ in real_images.values()]
        )

        # Update heading stream in reading order (fallback labels)
        events = []
        for (y_top, level, text, hx0, hx1) in heading_events_by_page.get(page_index, []):
            events.append({
                "y0": y_top, "x0": hx0, "x1": hx1, "priority": 0,
                "kind": "heading", "level": level, "text": text, "xref": None,
            })
        for xref, (bbox, _) in real_images.items():
            events.append({
                "y0": bbox.y0, "x0": bbox.x0, "x1": bbox.x1, "priority": 1,
                "kind": "image", "level": None, "text": None, "xref": xref,
            })
        events = order_page_events(events, split_x, page_width)

        page_heading_state = {
            "main": main_heading,
            "section": section_heading,
            "sub": sub_heading,
        }

        for e in events:
            if e["kind"] == "heading":
                level, text = e["level"], e["text"]
                if level == "main":
                    page_heading_state = {"main": text, "section": "", "sub": ""}
                elif level == "section":
                    page_heading_state["section"] = text
                    page_heading_state["sub"] = ""
                elif level == "sub":
                    page_heading_state["sub"] = text
                main_heading = page_heading_state["main"]
                section_heading = page_heading_state["section"]
                sub_heading = page_heading_state["sub"]
                continue

            xref = e["xref"]
            bbox, base_image = real_images[xref]
            image_bytes = base_image["image"]
            image_ext = base_image["ext"]

            # PRIMARY: proximity caption near this image
            caption = find_caption_for_image(bbox, text_blocks, body_size)
            caption_source = "proximity"

            if caption:
                title = caption["title"]
                main_h = title
                section_h = page_heading_state["section"]
                sub_h = page_heading_state["sub"]
                context = title
                if caption.get("position"):
                    caption_source = f"proximity-{caption['position']}"
            else:
                # FALLBACK: heading stream
                if page_heading_state["section"] and not is_junk_heading(page_heading_state["section"]):
                    parts = [page_heading_state["section"]]
                    if page_heading_state["sub"]:
                        parts.append(page_heading_state["sub"])
                elif page_heading_state["main"] and not is_junk_heading(page_heading_state["main"]):
                    parts = [page_heading_state["main"]]
                else:
                    parts = [f"page{page_index + 1}"]
                title = parts[0]
                main_h = page_heading_state["main"]
                section_h = page_heading_state["section"]
                sub_h = page_heading_state["sub"]
                context = " ".join(parts)
                caption_source = heading_source

            base_name = slugify(title) or f"image_{page_index + 1}"
            name_counter[base_name] += 1
            count = name_counter[base_name]
            suffix = "" if count == 1 else f"_{count}"
            image_name = f"{base_name}{suffix}.{image_ext}"
            image_path = os.path.join(output_dir, image_name)

            with open(image_path, "wb") as f:
                f.write(image_bytes)

            results.append({
                "imageName": image_name,
                "pageNumber": page_index + 1,
                "mainHeading": main_h,
                "sectionHeading": section_h,
                "subHeading": sub_h,
                "contextText": context,
                "headingSource": caption_source,
                "bbox": [bbox.x0, bbox.y0, bbox.x1, bbox.y1],
            })

    # Windows consoles often use cp1252 — force UTF-8 so special PDF chars don't crash
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.stdout.buffer.write(
        (json.dumps(results, ensure_ascii=False) + "\n").encode("utf-8", errors="replace")
    )
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
        print(json.dumps({"error": "Usage: extract_images.py <pdf_path> <output_dir>"}))
        sys.exit(1)

    extract(sys.argv[1], sys.argv[2])
