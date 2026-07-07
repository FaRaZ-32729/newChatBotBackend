
"""
extract_images.py

Extracts ONLY the truly embedded images from a PDF and tags each one with
the active heading hierarchy (Main Heading -> Section Heading -> Sub-heading)
at that point in the document.

TWO HEADING-DETECTION STRATEGIES (in priority order):
  1) TOC / Bookmarks strategy (most reliable):
     If the PDF has an embedded Table of Contents (outline/bookmarks —
     common in PDFs exported from Word, Google Docs, LaTeX, etc.), we use
     that directly. This is 100% accurate regardless of font size/design,
     because it reflects the author's actual intended structure.

  2) Font-size heuristic (fallback):
     If no TOC exists, we fall back to guessing headings from font size
     and boldness relative to the document's "body text" size. This is a
     heuristic and can misfire on unusually-styled documents.

COLUMN-AWARE READING ORDER (fix for multi-column pages):
  Previously, headings and images on a page were merged and sorted purely
  by their y-coordinate (top-to-bottom). This breaks on multi-column
  layouts: e.g. if text is in the left column and an image is in the
  right column at a similar height, pure y-sorting can interleave them
  in the wrong order, causing an image to get tagged with the wrong
  heading (or a heading meant for one column bleeding into the other).

  We now detect a left/right column split per page (using the x-position
  of ordinary body-text blocks, ignoring headings), classify every
  heading/image event as "left column", "right column", or "full width"
  (spans both columns -> treated as a section break), and then order
  events as: full-width items break the flow; between breaks, all left
  column items (top-to-bottom) come before all right column items
  (top-to-bottom). This matches natural reading order for 2-column
  brochures/reports/newsletters.

Requires: pip install PyMuPDF

Usage:
    python3 extract_images.py <pdf_path> <output_dir>

Prints a JSON array to stdout, one object per extracted image:
{
  "imageName": "...",
  "pageNumber": 1,
  "mainHeading": "...",
  "sectionHeading": "...",
  "subHeading": "...",
  "contextText": "...",
  "headingSource": "toc" | "font-size",
  "bbox": [x0, y0, x1, y1]
}
"""

import fitz  # PyMuPDF
import sys
import json
import os
import re
from collections import Counter, defaultdict

BOLD_FLAG = 1 << 4

# How much wider than half the page a block must be before we consider it
# "full width" (i.e. a heading/banner that spans both columns).
FULL_WIDTH_RATIO = 0.65

# Minimum horizontal gap (in points) between two merged text intervals
# before we trust it as a real column gutter (avoids false positives from
# small indentation differences).
MIN_COLUMN_GAP = 15


def slugify(text, maxlen=40):
    text = re.sub(r'[^a-zA-Z0-9]+', '_', text).strip('_')
    return text[:maxlen]


# ---------------------------------------------------------------------------
# Body font size (used both for the font-size heading heuristic AND for
# filtering out headings when detecting columns)
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Column detection (new)
# ---------------------------------------------------------------------------

def detect_page_columns(page, body_size, image_rects=None):
    """
    Looks at ordinary body-text blocks on the page (skipping large/bold
    heading-like blocks) PLUS any embedded images, and tries to find a
    vertical gutter that splits the page into two columns.

    Images are included deliberately: if one column is entirely an image
    (no text at all on that side), text-only detection would see just a
    single column and miss the split. Including image bboxes fixes the
    common "image fills the right column, text fills the left column"
    layout (and vice versa).

    Returns split_x (float) if a confident 2-column layout is detected,
    otherwise None (treat page as single-column / full width).
    """
    d = page.get_text("dict")
    intervals = []

    for block in d["blocks"]:
        if block["type"] != 0:
            continue
        max_size = 0
        for line in block["lines"]:
            for span in line["spans"]:
                size = round(span["size"], 1)
                if size > max_size:
                    max_size = size
        # Skip heading-like blocks (bigger than body text) - they tend to
        # span the full width and would mask the real column gutter.
        if max_size > body_size * 1.08:
            continue
        bbox = block["bbox"]
        intervals.append((bbox[0], bbox[2]))

    if image_rects:
        for rect in image_rects:
            intervals.append((rect.x0, rect.x1))

    if len(intervals) < 2:
        # Not enough content to confidently detect columns.
        return None

    intervals.sort()
    merged = []
    for (x0, x1) in intervals:
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
    """Classify an event's horizontal position as 'left', 'right', or 'full'."""
    if split_x is None:
        return 'full'
    width = (x1 - x0) if (x0 is not None and x1 is not None) else None
    if width is None:
        # Unknown width (e.g. TOC destination with only a point, no rect) —
        # assume it's a heading that spans the width, safest default.
        return 'full'
    if width > FULL_WIDTH_RATIO * page_width:
        return 'full'
    center = (x0 + x1) / 2.0
    return 'left' if center < split_x else 'right'


def order_page_events(events, split_x, page_width):
    """
    events: list of dicts with keys y0, x0, x1, priority, kind, level, text, xref
    Returns events reordered into natural (column-aware) reading order.
    """
    for e in events:
        e['col'] = classify_column(e['x0'], e['x1'], split_x, page_width)

    # Stable sort by y first so buffers fill in top-to-bottom order.
    events = sorted(events, key=lambda e: (round(e['y0'], 1), e['priority']))

    ordered = []
    buf_left, buf_right = [], []

    def flush():
        buf_left.sort(key=lambda e: (round(e['y0'], 1), e['priority']))
        buf_right.sort(key=lambda e: (round(e['y0'], 1), e['priority']))
        ordered.extend(buf_left)
        ordered.extend(buf_right)
        buf_left.clear()
        buf_right.clear()

    for e in events:
        if e['col'] == 'full':
            flush()
            ordered.append(e)
        elif e['col'] == 'left':
            buf_left.append(e)
        else:
            buf_right.append(e)
    flush()

    return ordered


# ---------------------------------------------------------------------------
# Strategy 1: TOC / Bookmarks
# ---------------------------------------------------------------------------

def get_toc_events(doc):
    """
    Returns (events_by_page, has_toc) where events_by_page maps
    page_index -> list of (y_top, level, title, x0, x1), using the PDF's
    own embedded outline/bookmarks. x0/x1 are None when we only have a
    destination point (no known width) — these are treated as full-width.
    """
    toc = doc.get_toc(simple=False)
    events_by_page = defaultdict(list)

    for entry in toc:
        lvl, title, page_num = entry[0], entry[1], entry[2]
        dest = entry[3] if len(entry) > 3 else None
        page_index = page_num - 1
        if page_index < 0 or page_index >= len(doc):
            continue

        page = doc[page_index]
        y_top = None
        x0 = None
        x1 = None

        if isinstance(dest, dict):
            to_point = dest.get('to')
            if to_point is not None:
                y_top = page.rect.height - to_point.y
                # Only a point is known here, not a width -> leave x1 as
                # None so it's classified as full-width (safe default).
                x0 = to_point.x

        if y_top is None:
            rects = page.search_for(title.strip())
            if rects:
                r = rects[0]
                y_top = r.y0
                x0 = r.x0
                x1 = r.x1

        if y_top is None:
            y_top = 0

        level = 'main' if lvl == 1 else ('section' if lvl == 2 else 'sub')
        events_by_page[page_index].append((y_top, level, title.strip(), x0, x1))

    return events_by_page, len(toc) > 0


# ---------------------------------------------------------------------------
# Strategy 2: Font-size heuristic (fallback when no TOC exists)
# ---------------------------------------------------------------------------

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
        if i == 0:
            tiers[size] = 'main'
        elif i == 1:
            tiers[size] = 'section'
        else:
            tiers[size] = 'sub'
    return tiers


def classify_block(block, body_size, tiers):
    if block["type"] != 0:
        return None, ""

    text_parts = []
    max_size = 0
    is_bold = False
    for line in block["lines"]:
        for span in line["spans"]:
            text_parts.append(span["text"])
            size = round(span["size"], 1)
            if size > max_size:
                max_size = size
                is_bold = bool(span["flags"] & BOLD_FLAG)

    text = "".join(text_parts).strip()
    if not text or len(text) > 80:
        return None, text

    level = tiers.get(max_size)
    if level is None and is_bold and max_size >= body_size:
        level = 'sub'

    return level, text


def get_font_size_events(doc, body_size):
    """Fallback strategy: returns events_by_page in the same shape as
    get_toc_events (y_top, level, text, x0, x1), derived from font-size
    classification."""
    tiers = get_heading_size_tiers(doc, body_size)
    events_by_page = defaultdict(list)

    for page_index in range(len(doc)):
        page = doc[page_index]
        d = page.get_text("dict")
        for block in d["blocks"]:
            level, text = classify_block(block, body_size, tiers)
            if level:
                bbox = block["bbox"]
                events_by_page[page_index].append((bbox[1], level, text, bbox[0], bbox[2]))

    return events_by_page


# ---------------------------------------------------------------------------
# Main extraction
# ---------------------------------------------------------------------------

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

        # Real embedded images with true bbox
        real_images = {}
        for img in page.get_images(full=True):
            xref = img[0]
            rects = page.get_image_rects(xref)
            if rects:
                real_images[xref] = rects[0]

        # Column detection uses both body text AND images, so an
        # image-only column (no text on that side) is still detected.
        split_x = detect_page_columns(page, body_size, list(real_images.values()))

        # Build a unified event list for this page
        events = []
        for (y_top, level, text, hx0, hx1) in heading_events_by_page.get(page_index, []):
            events.append({
                'y0': y_top, 'x0': hx0, 'x1': hx1, 'priority': 0,
                'kind': 'heading', 'level': level, 'text': text, 'xref': None
            })
        for xref, bbox in real_images.items():
            events.append({
                'y0': bbox.y0, 'x0': bbox.x0, 'x1': bbox.x1, 'priority': 1,
                'kind': 'image', 'level': None, 'text': None, 'xref': xref
            })

        # Column-aware ordering (fixes left/right column mixups)
        events = order_page_events(events, split_x, page_width)

        for e in events:
            if e['kind'] == 'heading':
                level, text = e['level'], e['text']
                if level == 'main':
                    main_heading = text
                    section_heading = ""
                    sub_heading = ""
                elif level == 'section':
                    section_heading = text
                    sub_heading = ""
                elif level == 'sub':
                    sub_heading = text
                continue

            # kind == 'image'
            xref = e['xref']
            bbox = real_images[xref]
            base_image = doc.extract_image(xref)
            image_bytes = base_image["image"]
            image_ext = base_image["ext"]

            if section_heading:
                parts = [section_heading] + ([sub_heading] if sub_heading else [])
            elif main_heading:
                parts = [main_heading]
            else:
                parts = [f"page{page_index + 1}"]

            base_name = slugify("_".join(parts)) or f"image_{page_index + 1}"

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
                "mainHeading": main_heading,
                "sectionHeading": section_heading,
                "subHeading": sub_heading,
                "contextText": " ".join(parts),
                "headingSource": heading_source,
                "bbox": [bbox.x0, bbox.y0, bbox.x1, bbox.y1]
            })

    print(json.dumps(results))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: extract_images.py <pdf_path> <output_dir>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_dir = sys.argv[2]
    extract(pdf_path, output_dir)
