# """
# extract_images.py

# Extracts ONLY the truly embedded images from a PDF (not full-page rasters),
# along with the exact position (bounding box) of each image, and the nearest
# heading (text just above the image) and caption/explanation (text just below
# the image) on that page. This context text is used to build a meaningful
# name for each image and to store contextual info alongside it.

# Requires: pip install PyMuPDF

# Usage:
#     python3 extract_images.py <pdf_path> <output_dir>

# Prints a JSON array to stdout, one object per extracted image:
# {
#   "imageName": "...",
#   "pageNumber": 1,
#   "heading": "...",
#   "caption": "...",
#   "contextText": "...",
#   "bbox": [x0, y0, x1, y1]
# }
# """

# import fitz  # PyMuPDF
# import sys
# import json
# import os
# import re


# def slugify(text, maxlen=50):
#     """Turn arbitrary heading/caption text into a safe filename fragment."""
#     text = re.sub(r'[^a-zA-Z0-9]+', '_', text).strip('_')
#     return text[:maxlen] or 'image'


# def get_context_for_image(page, img_bbox, threshold=40):
#     """
#     Look at all text blocks on the page and find:
#       - the closest block ABOVE the image within `threshold` points -> heading
#       - the closest block BELOW the image within `threshold` points -> caption

#     PyMuPDF's coordinate system has y increasing downward (top-left origin),
#     so "above" means a smaller y1 than the image's y0, and "below" means a
#     larger y0 than the image's y1.
#     """
#     blocks = page.get_text("blocks")  # (x0, y0, x1, y1, text, block_no, block_type)

#     heading_candidates = []
#     caption_candidates = []

#     for b in blocks:
#         x0, y0, x1, y1, text, block_no, block_type = b
#         text = text.strip()
#         if not text or block_type != 0:  # 0 = text block
#             continue

#         # Block ends above the image, within threshold -> candidate heading
#         gap_above = img_bbox.y0 - y1
#         if 0 <= gap_above <= threshold:
#             heading_candidates.append((gap_above, text))

#         # Block starts below the image, within threshold -> candidate caption
#         gap_below = y0 - img_bbox.y1
#         if 0 <= gap_below <= threshold:
#             caption_candidates.append((gap_below, text))

#     heading_candidates.sort(key=lambda t: t[0])
#     caption_candidates.sort(key=lambda t: t[0])

#     heading = heading_candidates[0][1] if heading_candidates else ""
#     caption = caption_candidates[0][1] if caption_candidates else ""
#     return heading, caption


# def extract(pdf_path, output_dir):
#     doc = fitz.open(pdf_path)
#     os.makedirs(output_dir, exist_ok=True)
#     results = []

#     for page_index in range(len(doc)):
#         page = doc[page_index]
#         image_list = page.get_images(full=True)  # only real embedded images

#         for img_index, img in enumerate(image_list):
#             xref = img[0]

#             base_image = doc.extract_image(xref)  # raw bytes, no re-rendering
#             image_bytes = base_image["image"]
#             image_ext = base_image["ext"]

#             # Where does this image actually sit on the page?
#             rects = page.get_image_rects(xref)
#             bbox = rects[0] if rects else None

#             heading, caption = ("", "")
#             if bbox:
#                 heading, caption = get_context_for_image(page, bbox)

#             context_text = f"{heading} {caption}".strip()
#             slug = slugify(context_text) if context_text else f"page{page_index + 1}_img{img_index + 1}"

#             image_name = f"{slug}_{page_index + 1}_{img_index + 1}.{image_ext}"
#             image_path = os.path.join(output_dir, image_name)

#             with open(image_path, "wb") as f:
#                 f.write(image_bytes)

#             results.append({
#                 "imageName": image_name,
#                 "pageNumber": page_index + 1,
#                 "heading": heading,
#                 "caption": caption,
#                 "contextText": context_text,
#                 "bbox": [bbox.x0, bbox.y0, bbox.x1, bbox.y1] if bbox else None
#             })

#     print(json.dumps(results))


# if __name__ == "__main__":
#     if len(sys.argv) < 3:
#         print(json.dumps({"error": "Usage: extract_images.py <pdf_path> <output_dir>"}))
#         sys.exit(1)

#     pdf_path = sys.argv[1]
#     output_dir = sys.argv[2]
#     extract(pdf_path, output_dir)



# """
# extract_images.py

# Extracts ONLY the truly embedded images from a PDF (not full-page rasters).
# Instead of naming each image after the nearest random line of text, this
# version builds a HEADING HIERARCHY as it walks through the document
# (Main Heading -> Section Heading -> Sub-heading), based on font size
# (and boldness), and tags every image with whichever heading is
# "active" at that point in the document.

# Example:
#     "Polekit"                (title / main heading, size 28)
#       [image A]              -> name: polekit.png
#     "Features"                (section heading, size 20)
#       [image B]              -> name: features.png
#       "Installation"          (sub-heading, size 16)
#       [image C]              -> name: features_installation.png

# Requires: pip install PyMuPDF

# Usage:
#     python3 extract_images.py <pdf_path> <output_dir>

# Prints a JSON array to stdout, one object per extracted image:
# {
#   "imageName": "...",
#   "pageNumber": 1,
#   "mainHeading": "...",
#   "sectionHeading": "...",
#   "subHeading": "...",
#   "contextText": "...",
#   "bbox": [x0, y0, x1, y1]
# }
# """

# import fitz  # PyMuPDF
# import sys
# import json
# import os
# import re
# from collections import Counter

# BOLD_FLAG = 1 << 4  # PyMuPDF span flag bit for bold text


# def slugify(text, maxlen=40):
#     text = re.sub(r'[^a-zA-Z0-9]+', '_', text).strip('_')
#     return text[:maxlen]


# def get_body_font_size(doc):
#     """Find the most common font size across the whole document (weighted
#     by character count) -> this is treated as 'normal paragraph text'."""
#     counter = Counter()
#     for page in doc:
#         d = page.get_text("dict")
#         for block in d["blocks"]:
#             if block["type"] != 0:
#                 continue
#             for line in block["lines"]:
#                 for span in line["spans"]:
#                     size = round(span["size"], 1)
#                     counter[size] += len(span["text"])
#     if not counter:
#         return 10.0
#     return counter.most_common(1)[0][0]


# def get_heading_size_tiers(doc, body_size):
#     """Collect distinct font sizes noticeably larger than body text and
#     rank them: biggest = main heading tier, next = section, next = sub."""
#     sizes = set()
#     for page in doc:
#         d = page.get_text("dict")
#         for block in d["blocks"]:
#             if block["type"] != 0:
#                 continue
#             for line in block["lines"]:
#                 for span in line["spans"]:
#                     size = round(span["size"], 1)
#                     is_bold = bool(span["flags"] & BOLD_FLAG)
#                     if size > body_size * 1.08 or (is_bold and size >= body_size):
#                         sizes.add(size)

#     sizes = sorted(sizes, reverse=True)
#     tiers = {}
#     for i, size in enumerate(sizes):
#         if i == 0:
#             tiers[size] = 'main'
#         elif i == 1:
#             tiers[size] = 'section'
#         else:
#             tiers[size] = 'sub'
#     return tiers


# def classify_block(block, body_size, tiers):
#     """Return ('main' | 'section' | 'sub' | None, text) for a text block."""
#     if block["type"] != 0:
#         return None, ""

#     text_parts = []
#     max_size = 0
#     is_bold = False
#     for line in block["lines"]:
#         for span in line["spans"]:
#             text_parts.append(span["text"])
#             size = round(span["size"], 1)
#             if size > max_size:
#                 max_size = size
#                 is_bold = bool(span["flags"] & BOLD_FLAG)

#     text = "".join(text_parts).strip()
#     if not text:
#         return None, ""

#     # Headings are short lines, not full paragraphs
#     if len(text) > 80:
#         return None, text

#     level = tiers.get(max_size)
#     if level is None and is_bold and max_size >= body_size:
#         level = 'sub'  # bold body-sized text with no bigger heading tier -> treat as sub-heading

#     return level, text


# def extract(pdf_path, output_dir):
#     doc = fitz.open(pdf_path)
#     os.makedirs(output_dir, exist_ok=True)

#     body_size = get_body_font_size(doc)
#     tiers = get_heading_size_tiers(doc, body_size)

#     results = []
#     name_counter = Counter()

#     main_heading = ""
#     section_heading = ""
#     sub_heading = ""

#     for page_index in range(len(doc)):
#         page = doc[page_index]

#         # Real embedded images with true bbox (for actual extraction)
#         real_images = {}  # xref -> bbox
#         for img in page.get_images(full=True):
#             xref = img[0]
#             rects = page.get_image_rects(xref)
#             if rects:
#                 real_images[xref] = rects[0]

#         # Build a single ordered list of "events" (text blocks + image blocks)
#         # sorted top-to-bottom, left-to-right, to walk in reading order.
#         d = page.get_text("dict")
#         events = []

#         for block in d["blocks"]:
#             bbox = block["bbox"]
#             if block["type"] == 0:
#                 level, text = classify_block(block, body_size, tiers)
#                 events.append((bbox[1], bbox[0], 'text', level, text, None))
#             # NOTE: we don't rely on dict's own image blocks for extraction
#             # (they can be duplicated/inlined); we only use them for ordering
#             # if needed. Real images are merged in below by bbox instead.

#         for xref, bbox in real_images.items():
#             events.append((bbox.y0, bbox.x0, 'image', None, None, xref))

#         events.sort(key=lambda e: (round(e[0], 1), e[1]))

#         for (_, _, kind, level, text, xref) in events:
#             if kind == 'text':
#                 if level == 'main':
#                     main_heading = text
#                     section_heading = ""
#                     sub_heading = ""
#                 elif level == 'section':
#                     section_heading = text
#                     sub_heading = ""
#                 elif level == 'sub':
#                     sub_heading = text
#                 continue

#             # kind == 'image'
#             bbox = real_images[xref]
#             base_image = doc.extract_image(xref)
#             image_bytes = base_image["image"]
#             image_ext = base_image["ext"]

#             if section_heading:
#                 parts = [section_heading] + ([sub_heading] if sub_heading else [])
#             elif main_heading:
#                 parts = [main_heading]
#             else:
#                 parts = [f"page{page_index + 1}"]

#             base_name = slugify("_".join(parts)) or f"image_{page_index + 1}"

#             name_counter[base_name] += 1
#             count = name_counter[base_name]
#             suffix = "" if count == 1 else f"_{count}"

#             image_name = f"{base_name}{suffix}.{image_ext}"
#             image_path = os.path.join(output_dir, image_name)

#             with open(image_path, "wb") as f:
#                 f.write(image_bytes)

#             results.append({
#                 "imageName": image_name,
#                 "pageNumber": page_index + 1,
#                 "mainHeading": main_heading,
#                 "sectionHeading": section_heading,
#                 "subHeading": sub_heading,
#                 "contextText": " ".join(parts),
#                 "bbox": [bbox.x0, bbox.y0, bbox.x1, bbox.y1]
#             })

#     print(json.dumps(results))


# if __name__ == "__main__":
#     if len(sys.argv) < 3:
#         print(json.dumps({"error": "Usage: extract_images.py <pdf_path> <output_dir>"}))
#         sys.exit(1)

#     pdf_path = sys.argv[1]
#     output_dir = sys.argv[2]
#     extract(pdf_path, output_dir)


"""
extract_images.py

Extracts ONLY the truly embedded images from a PDF and tags each one with
the active heading hierarchy (Main Heading -> Section Heading -> Sub-heading)
at that point in the document.

TWO STRATEGIES (in priority order):
  1) TOC / Bookmarks strategy (most reliable):
     If the PDF has an embedded Table of Contents (outline/bookmarks —
     common in PDFs exported from Word, Google Docs, LaTeX, etc.), we use
     that directly. This is 100% accurate regardless of font size/design,
     because it reflects the author's actual intended structure.

  2) Font-size heuristic (fallback):
     If no TOC exists, we fall back to guessing headings from font size
     and boldness relative to the document's "body text" size. This is a
     heuristic and can misfire on unusually-styled documents.

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


def slugify(text, maxlen=40):
    text = re.sub(r'[^a-zA-Z0-9]+', '_', text).strip('_')
    return text[:maxlen]


# ---------------------------------------------------------------------------
# Strategy 1: TOC / Bookmarks
# ---------------------------------------------------------------------------

def get_toc_events(doc):
    """
    Returns (events_by_page, has_toc) where events_by_page maps
    page_index -> list of (y_top, level, title), using the PDF's own
    embedded outline/bookmarks.
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

        # Try to get the exact vertical position the bookmark points to
        if isinstance(dest, dict):
            to_point = dest.get('to')
            if to_point is not None:
                # PDF space has bottom-left origin; convert to top-left
                # to match get_text("dict") coordinate space.
                y_top = page.rect.height - to_point.y

        # Fallback: search for the title text on that page to find its position
        if y_top is None:
            rects = page.search_for(title.strip())
            if rects:
                y_top = rects[0].y0

        if y_top is None:
            y_top = 0  # unknown position -> assume top of page

        level = 'main' if lvl == 1 else ('section' if lvl == 2 else 'sub')
        events_by_page[page_index].append((y_top, level, title.strip()))

    return events_by_page, len(toc) > 0


# ---------------------------------------------------------------------------
# Strategy 2: Font-size heuristic (fallback when no TOC exists)
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


def get_font_size_events(doc):
    """Fallback strategy: returns events_by_page in the same shape as
    get_toc_events, but derived from font-size classification."""
    body_size = get_body_font_size(doc)
    tiers = get_heading_size_tiers(doc, body_size)
    events_by_page = defaultdict(list)

    for page_index in range(len(doc)):
        page = doc[page_index]
        d = page.get_text("dict")
        for block in d["blocks"]:
            level, text = classify_block(block, body_size, tiers)
            if level:
                bbox = block["bbox"]
                events_by_page[page_index].append((bbox[1], level, text))

    return events_by_page


# ---------------------------------------------------------------------------
# Main extraction
# ---------------------------------------------------------------------------

def extract(pdf_path, output_dir):
    doc = fitz.open(pdf_path)
    os.makedirs(output_dir, exist_ok=True)

    toc_events_by_page, has_toc = get_toc_events(doc)

    if has_toc:
        heading_events_by_page = toc_events_by_page
        heading_source = "toc"
    else:
        heading_events_by_page = get_font_size_events(doc)
        heading_source = "font-size"

    results = []
    name_counter = Counter()

    main_heading = ""
    section_heading = ""
    sub_heading = ""

    for page_index in range(len(doc)):
        page = doc[page_index]

        # Real embedded images with true bbox
        real_images = {}
        for img in page.get_images(full=True):
            xref = img[0]
            rects = page.get_image_rects(xref)
            if rects:
                real_images[xref] = rects[0]

        # Merge heading events + image events for this page, sorted top-to-bottom
        events = []
        for (y_top, level, text) in heading_events_by_page.get(page_index, []):
            events.append((y_top, 0, 'heading', level, text, None))
        for xref, bbox in real_images.items():
            events.append((bbox.y0, 1, 'image', None, None, xref))

        events.sort(key=lambda e: (round(e[0], 1), e[1]))

        for (_, _, kind, level, text, xref) in events:
            if kind == 'heading':
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