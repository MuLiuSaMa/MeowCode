#!/usr/bin/env python3
"""Unpack and format XML contents of PPTX files.

Usage: python unpack.py <pptx_file> <output_dir>

Example:
    python unpack.py presentation.pptx unpacked/
"""

import sys
import zipfile
from pathlib import Path

import defusedxml.minidom

# Smart quotes that get mangled by the tokenizer - convert to XML entities
SMART_QUOTE_REPLACEMENTS = {
    "\u201c": "&#x201C;",  # Left double quote "
    "\u201d": "&#x201D;",  # Right double quote "
    "\u2018": "&#x2018;",  # Left single quote '
    "\u2019": "&#x2019;",  # Right single quote '
}


def unpack(input_file: str, output_dir: str) -> None:
    """Unpack a PPTX file and pretty-print XML contents.

    Args:
        input_file: Path to PPTX file
        output_dir: Path to output directory
    """
    input_path = Path(input_file)
    output_path = Path(output_dir)

    if not input_path.exists():
        print(f"Error: {input_file} not found", file=sys.stderr)
        sys.exit(1)

    if input_path.suffix.lower() != ".pptx":
        print(f"Error: {input_file} must be a .pptx file", file=sys.stderr)
        sys.exit(1)

    # Extract
    output_path.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(input_path, "r") as zf:
        zf.extractall(output_path)

    # Pretty print all XML files
    xml_files = list(output_path.rglob("*.xml")) + list(output_path.rglob("*.rels"))
    for xml_file in xml_files:
        _pretty_print_xml(xml_file)

    # Escape smart quotes so they survive tokenization
    for xml_file in xml_files:
        _escape_smart_quotes(xml_file)

    print(f"Unpacked {input_file} to {output_dir}")


def _pretty_print_xml(xml_file: Path) -> None:
    """Pretty print an XML file with indentation."""
    try:
        content = xml_file.read_text(encoding="utf-8")
        dom = defusedxml.minidom.parseString(content)
        xml_file.write_bytes(dom.toprettyxml(indent="  ", encoding="utf-8"))
    except Exception:
        pass  # Skip files that can't be parsed


def _escape_smart_quotes(xml_file: Path) -> None:
    """Replace smart quotes with XML entities so they survive tokenization."""
    try:
        content = xml_file.read_text(encoding="utf-8")
        for char, entity in SMART_QUOTE_REPLACEMENTS.items():
            content = content.replace(char, entity)
        xml_file.write_text(content, encoding="utf-8")
    except Exception:
        pass


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python unpack.py <pptx_file> <output_dir>", file=sys.stderr)
        sys.exit(1)

    unpack(sys.argv[1], sys.argv[2])
