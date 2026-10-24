#!/usr/bin/env python3

import argparse
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Dict

import defusedxml.minidom


def sanitize(input_file: str) -> tuple[None, str]:
    input_path = Path(input_file)

    if not input_path.exists():
        return None, f"Error: Input file not found: {input_file}"

    if input_path.suffix.lower() != ".docx":
        return None, f"Error: Input file is not a DOCX file: {input_file}"

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        with zipfile.ZipFile(input_path, "r") as zf:
            zf.extractall(temp_path)

        stats = _sanitize_document_xml(temp_path / "word" / "document.xml")

        temp_out = _get_nonexistent_path(input_path.with_suffix(".sanitized.tmp.docx"))
        _pack_docx_dir(temp_path, temp_out)
        os.replace(temp_out, input_path)
        message = f"Successfully sanitized in place: {input_path}"

    return None, (
        f"{message} "
        f"(toc_removed_paragraphs: {stats['toc_removed_paragraphs']}, "
        f"blank_removed_paragraphs: {stats['blank_removed_paragraphs']}, "
        f"removed_paragraphs_total: {stats['removed_paragraphs_total']}, "
        f"pages_estimated: {stats['pages_before']} -> {stats['pages_after']}, "
        f"pages_removed_estimated: {max(0, stats['pages_before'] - stats['pages_after'])})"
    )


def _sanitize_document_xml(document_xml: Path) -> Dict[str, int]:
    if not document_xml.exists():
        return {
            "toc_removed_paragraphs": 0,
            "blank_removed_paragraphs": 0,
            "removed_paragraphs_total": 0,
            "page_breaks_before": 0,
            "page_breaks_after": 0,
            "pages_before": 1,
            "pages_after": 1,
        }
    try:
        content = document_xml.read_text(encoding="utf-8")
        dom = defusedxml.minidom.parseString(content)
    except Exception:
        return {
            "toc_removed_paragraphs": 0,
            "blank_removed_paragraphs": 0,
            "removed_paragraphs_total": 0,
            "page_breaks_before": 0,
            "page_breaks_after": 0,
            "pages_before": 1,
            "pages_after": 1,
        }

    body = dom.getElementsByTagName("w:body")
    if not body:
        return {
            "toc_removed_paragraphs": 0,
            "blank_removed_paragraphs": 0,
            "removed_paragraphs_total": 0,
            "page_breaks_before": 0,
            "page_breaks_after": 0,
            "pages_before": 1,
            "pages_after": 1,
        }
    body = body[0]
    paragraphs = [
        node
        for node in body.childNodes
        if node.nodeType == node.ELEMENT_NODE
        and (node.localName == "p" or node.tagName.endswith(":p"))
    ]
    if not paragraphs:
        return {
            "toc_removed_paragraphs": 0,
            "blank_removed_paragraphs": 0,
            "removed_paragraphs_total": 0,
            "page_breaks_before": 0,
            "page_breaks_after": 0,
            "pages_before": 1,
            "pages_after": 1,
        }

    page_breaks_before = _count_explicit_page_breaks(paragraphs)
    pages_before = 1 + page_breaks_before

    toc_removed = 0
    blank_removed = 0
    to_remove = []
    to_remove_ids: set[int] = set()
    i = 0
    while i < len(paragraphs):
        p = paragraphs[i]
        text = _paragraph_text(p)
        if _is_text_toc_heading(text):
            pid = id(p)
            if pid not in to_remove_ids:
                to_remove.append(p)
                to_remove_ids.add(pid)
                toc_removed += 1
            i += 1
            while i < len(paragraphs):
                next_p = paragraphs[i]
                if _is_page_break_paragraph(next_p):
                    nid = id(next_p)
                    if nid not in to_remove_ids:
                        to_remove.append(next_p)
                        to_remove_ids.add(nid)
                        toc_removed += 1
                    i += 1
                    break
                if _paragraph_style(next_p).lower().startswith("heading"):
                    break
                nid = id(next_p)
                if nid not in to_remove_ids:
                    to_remove.append(next_p)
                    to_remove_ids.add(nid)
                    toc_removed += 1
                i += 1
            continue
        i += 1

    for idx in range(len(paragraphs) - 1):
        current_p = paragraphs[idx]
        next_p = paragraphs[idx + 1]
        if _has_sectpr(current_p) and _is_page_break_paragraph(next_p):
            nid = id(next_p)
            if nid not in to_remove_ids:
                to_remove.append(next_p)
                to_remove_ids.add(nid)
                blank_removed += 1

    if to_remove:
        for p in to_remove:
            body.removeChild(p)
        document_xml.write_bytes(dom.toxml(encoding="UTF-8"))

    paragraphs_after = [
        node
        for node in body.childNodes
        if node.nodeType == node.ELEMENT_NODE
        and (node.localName == "p" or node.tagName.endswith(":p"))
    ]
    page_breaks_after = _count_explicit_page_breaks(paragraphs_after)
    pages_after = 1 + page_breaks_after

    return {
        "toc_removed_paragraphs": toc_removed,
        "blank_removed_paragraphs": blank_removed,
        "removed_paragraphs_total": toc_removed + blank_removed,
        "page_breaks_before": page_breaks_before,
        "page_breaks_after": page_breaks_after,
        "pages_before": pages_before,
        "pages_after": pages_after,
    }


def _pack_docx_dir(input_dir: Path, output_file: Path) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_file, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in input_dir.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(input_dir))


def _get_nonexistent_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    for i in range(1, 1000):
        candidate = path.with_name(f"{stem}-{i}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError("Failed to find a free path for temporary output")


def _paragraph_text(paragraph) -> str:
    parts = []
    for node in paragraph.childNodes:
        if node.nodeType != node.ELEMENT_NODE:
            continue
        name = node.localName or node.tagName
        if name == "r" or name.endswith(":r"):
            for child in node.childNodes:
                if child.nodeType != child.ELEMENT_NODE:
                    continue
                cname = child.localName or child.tagName
                if cname == "t" or cname.endswith(":t"):
                    if child.firstChild and child.firstChild.nodeValue:
                        parts.append(child.firstChild.nodeValue)
    return "".join(parts)


def _is_text_toc_heading(text: str) -> bool:
    normalized = re.sub(r"[\s\u00A0\u3000]+", "", text.strip()).lower()
    return normalized in {"目录", "目錄", "tableofcontents", "contents"}


def _has_sectpr(paragraph) -> bool:
    for node in paragraph.childNodes:
        if node.nodeType == node.ELEMENT_NODE:
            name = node.localName or node.tagName
            if name == "pPr" or name.endswith(":pPr"):
                for child in node.childNodes:
                    if child.nodeType == child.ELEMENT_NODE:
                        cname = child.localName or child.tagName
                        if cname == "sectPr" or cname.endswith(":sectPr"):
                            return True
    return False


def _paragraph_style(paragraph) -> str:
    for node in paragraph.childNodes:
        if node.nodeType != node.ELEMENT_NODE:
            continue
        name = node.localName or node.tagName
        if name == "pPr" or name.endswith(":pPr"):
            for child in node.childNodes:
                if child.nodeType != child.ELEMENT_NODE:
                    continue
                cname = child.localName or child.tagName
                if cname == "pStyle" or cname.endswith(":pStyle"):
                    val = child.getAttribute("w:val") or child.getAttribute("val")
                    return val or ""
    return ""


def _is_page_break_paragraph(paragraph) -> bool:
    has_page_break = False
    for node in paragraph.childNodes:
        if node.nodeType != node.ELEMENT_NODE:
            continue
        name = node.localName or node.tagName
        if name in {"pPr", "r"} or name.endswith(":pPr") or name.endswith(":r"):
            if name == "r" or name.endswith(":r"):
                for r_child in node.childNodes:
                    if r_child.nodeType != r_child.ELEMENT_NODE:
                        continue
                    r_name = r_child.localName or r_child.tagName
                    if r_name == "br" or r_name.endswith(":br"):
                        if r_child.getAttribute("w:type") in {"page", "PAGE"}:
                            has_page_break = True
                        elif r_child.getAttribute("type") == "page":
                            has_page_break = True
                    elif r_name == "t" or r_name.endswith(":t"):
                        if r_child.firstChild and r_child.firstChild.nodeValue.strip():
                            return False
                    elif not (r_name == "rPr" or r_name.endswith(":rPr")):
                        return False
        else:
            return False
    return has_page_break


def _has_page_break_before(paragraph) -> bool:
    for node in paragraph.childNodes:
        if node.nodeType != node.ELEMENT_NODE:
            continue
        name = node.localName or node.tagName
        if name == "pPr" or name.endswith(":pPr"):
            for child in node.childNodes:
                if child.nodeType != child.ELEMENT_NODE:
                    continue
                cname = child.localName or child.tagName
                if cname == "pageBreakBefore" or cname.endswith(":pageBreakBefore"):
                    return True
    return False


def _count_explicit_page_breaks(paragraphs: list) -> int:
    count = 0
    for p in paragraphs:
        if _is_page_break_paragraph(p) or _has_page_break_before(p):
            count += 1
    return count


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sanitize DOCX output")
    parser.add_argument("input_file", help="Input DOCX file")
    args = parser.parse_args()

    _, message = sanitize(args.input_file)
    print(message)
    if "Error" in message:
        sys.exit(1)
