#!/usr/bin/env python3
"""Pack a directory into a PPTX file.

Validates with auto-repair, condenses XML formatting, and creates the PPTX.
"""

import argparse
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import defusedxml.minidom

from ooxml.scripts.validation import PPTXSchemaValidator

# Smart quotes to re-encode after DOM serialization (DOM decodes entities to Unicode)
SMART_QUOTE_REPLACEMENTS = {
    "\u201c": "&#x201C;",  # Left double quote "
    "\u201d": "&#x201D;",  # Right double quote "
    "\u2018": "&#x2018;",  # Left single quote '
    "\u2019": "&#x2019;",  # Right single quote '
}


def pack(
    input_directory: str,
    output_file: str,
    original_file: str | None = None,
    validate: bool = True,
) -> tuple[None, str]:
    """Pack a directory into a PPTX file.

    Args:
        input_directory: Path to unpacked PPTX directory
        output_file: Path to output PPTX file
        original_file: Path to original PPTX for validation comparison
        validate: If True, run validation with auto-repair before packing

    Returns:
        (None, message) - message indicates success or failure
    """
    input_dir = Path(input_directory)
    output_path = Path(output_file)

    if not input_dir.is_dir():
        return None, f"Error: {input_dir} is not a directory"

    if output_path.suffix.lower() != ".pptx":
        return None, f"Error: {output_file} must be a .pptx file"

    # Validate with auto-repair if requested and original file provided
    if validate and original_file:
        original_path = Path(original_file)
        if original_path.exists():
            success, output = _run_validation(input_dir, original_path)
            if output:
                print(output)
            if not success:
                return None, f"Error: Validation failed for {input_dir}"

    # Work in temporary directory to avoid modifying original
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_content_dir = Path(temp_dir) / "content"
        shutil.copytree(input_dir, temp_content_dir)

        # Process XML files to remove pretty-printing whitespace
        for pattern in ["*.xml", "*.rels"]:
            for xml_file in temp_content_dir.rglob(pattern):
                _condense_xml(xml_file)

        # Create final PPTX file as zip archive
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in temp_content_dir.rglob("*"):
                if f.is_file():
                    zf.write(f, f.relative_to(temp_content_dir))

    return None, f"Successfully packed {input_dir} to {output_file}"


def _run_validation(unpacked_dir: Path, original_file: Path) -> tuple[bool, str | None]:
    """Run validation with auto-repair.

    Returns:
        (success, output) - success is True if all validations pass
    """
    output_lines = []

    # Run auto-repair
    validator = PPTXSchemaValidator(unpacked_dir, original_file)
    repairs = validator.repair()
    if repairs:
        output_lines.append(f"Auto-repaired {repairs} issue(s)")

    # Run validation
    validator = PPTXSchemaValidator(unpacked_dir, original_file)
    success = validator.validate()

    if success:
        output_lines.append("All validations PASSED!")

    return success, "\n".join(output_lines) if output_lines else None


def _encode_smart_quotes(text: str) -> str:
    """Re-encode smart quotes as XML entities after DOM serialization."""
    for char, entity in SMART_QUOTE_REPLACEMENTS.items():
        text = text.replace(char, entity)
    return text


def _condense_xml(xml_file: Path) -> None:
    """Strip unnecessary whitespace and remove comments from XML."""
    try:
        with open(xml_file, encoding="utf-8") as f:
            dom = defusedxml.minidom.parse(f)

        # Process each element to remove whitespace and comments
        for element in dom.getElementsByTagName("*"):
            # Skip text elements (w:t, a:t, etc.) - preserve their content
            if element.tagName.endswith(":t"):
                continue

            # Remove whitespace-only text nodes and comment nodes
            for child in list(element.childNodes):
                if (
                    child.nodeType == child.TEXT_NODE
                    and child.nodeValue
                    and child.nodeValue.strip() == ""
                ) or child.nodeType == child.COMMENT_NODE:
                    element.removeChild(child)

        # Re-encode smart quotes that DOM decoded to Unicode
        output = _encode_smart_quotes(dom.toxml(encoding="UTF-8").decode("utf-8"))
        xml_file.write_text(output, encoding="utf-8")
    except Exception:
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pack a directory into a PPTX file")
    parser.add_argument("input_directory", help="Unpacked PPTX directory")
    parser.add_argument("output_file", help="Output PPTX file")
    parser.add_argument(
        "--original",
        help="Original PPTX file for validation comparison",
    )
    parser.add_argument(
        "--validate",
        type=lambda x: x.lower() == "true",
        default=True,
        metavar="true|false",
        help="Run validation with auto-repair (default: true)",
    )
    args = parser.parse_args()

    _, message = pack(
        args.input_directory,
        args.output_file,
        original_file=args.original,
        validate=args.validate,
    )
    print(message)

    if "Error" in message:
        sys.exit(1)
