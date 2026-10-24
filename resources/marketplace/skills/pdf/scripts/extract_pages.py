#!/usr/bin/env python3
import os
import re
import sys
from collections import defaultdict

import pdfplumber


CID_PATTERN = re.compile(r"\(cid:\d+\)")
CTRL_PATTERN = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
SPACE_PATTERN = re.compile(r"\s+")
LONG_ASCII_TOKEN_PATTERN = re.compile(r"[A-Za-z]{25,}")


def sanitize_text(text):
    removed = len(CID_PATTERN.findall(text))
    text = CID_PATTERN.sub("", text)
    text = CTRL_PATTERN.sub(" ", text)
    lines = []
    for line in text.splitlines():
        clean_line = SPACE_PATTERN.sub(" ", line).strip()
        if clean_line:
            lines.append(clean_line)
    return "\n".join(lines), removed


def looks_like_missing_spaces(text):
    return bool(LONG_ASCII_TOKEN_PATTERN.search(text))


def extract_text_with_word_spacing(page):
    words = page.extract_words(x_tolerance=1, y_tolerance=3, use_text_flow=True) or []
    if not words:
        return ""
    rows = defaultdict(list)
    for word in words:
        top = round(float(word["top"]), 1)
        rows[top].append(word)
    lines = []
    for top in sorted(rows.keys()):
        row_words = sorted(rows[top], key=lambda w: float(w["x0"]))
        line = " ".join(w["text"] for w in row_words if w.get("text"))
        line = SPACE_PATTERN.sub(" ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def extract_pages(pdf_path, output_dir):
    pages_dir = os.path.join(output_dir, "pages")
    os.makedirs(pages_dir, exist_ok=True)

    count = 0
    removed_total = 0
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            raw_text = page.extract_text(layout=True, x_tolerance=2, y_tolerance=3) or ""
            if looks_like_missing_spaces(raw_text):
                fallback_text = extract_text_with_word_spacing(page)
                if fallback_text:
                    raw_text = fallback_text
            text, removed = sanitize_text(raw_text)
            removed_total += removed
            file_name = f"page_{i:04d}.txt"
            file_path = os.path.join(pages_dir, file_name)
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(text)
            count += 1

    print(f"Extracted {count} pages to {pages_dir}")
    print(f"Removed {removed_total} cid tokens")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: extract_pages.py <input.pdf> <output_dir>")
        sys.exit(1)
    extract_pages(sys.argv[1], sys.argv[2])
