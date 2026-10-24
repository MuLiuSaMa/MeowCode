#!/usr/bin/env python3
"""Remove unreferenced files from an unpacked PPTX directory.

Usage: python clean.py <unpacked_dir>

Example:
    python clean.py unpacked/

This script removes:
- Orphaned slides (not in sldIdLst) and their relationships
- [trash] directory (unreferenced files)
- Orphaned .rels files for deleted resources
- Unreferenced media, embeddings, charts, diagrams, drawings, ink files
- Unreferenced theme files
- Unreferenced notes slides
- Content-Type overrides for deleted files
"""

import sys
from pathlib import Path

import defusedxml.minidom


import re

BULLET_PREFIX_RE = re.compile(r'^(?:[\u2022\u2023\u25E6\u2043\u2219\u00B7\u25CF\u25CB\u25AA\u25AB\u2013\u2014]\s*|\-\s+)')

_SHADOW_DEFAULTS = {
    "blurRad": "50800",
    "dist": "25400",
    "dir": "16200000",
}
_ALPHA_DEFAULT = "15000"
_MAX_BLUR_RAD = 2000000
_MAX_DIST = 2000000
_MAX_DIR = 21600000
_MAX_ALPHA = 100000


def fix_shadow_overflow(unpacked_dir: Path) -> int:
    slides_dir = unpacked_dir / "ppt" / "slides"
    if not slides_dir.exists():
        return 0
    fixed = 0
    for slide_file in sorted(slides_dir.glob("slide*.xml")):
        dom = defusedxml.minidom.parse(str(slide_file))
        changed = False
        for shdw in dom.getElementsByTagName("a:outerShdw"):
            for attr, max_val, default in [
                ("blurRad", _MAX_BLUR_RAD, _SHADOW_DEFAULTS["blurRad"]),
                ("dist", _MAX_DIST, _SHADOW_DEFAULTS["dist"]),
                ("dir", _MAX_DIR, _SHADOW_DEFAULTS["dir"]),
            ]:
                raw = shdw.getAttribute(attr)
                if not raw:
                    continue
                try:
                    val = float(raw)
                except ValueError:
                    val = float("inf")
                if val > max_val:
                    shdw.setAttribute(attr, default)
                    changed = True
                    fixed += 1
            for alpha_el in shdw.getElementsByTagName("a:alpha"):
                raw = alpha_el.getAttribute("val")
                if not raw:
                    continue
                try:
                    val = float(raw)
                except ValueError:
                    val = float("inf")
                if val > _MAX_ALPHA:
                    alpha_el.setAttribute("val", _ALPHA_DEFAULT)
                    changed = True
                    fixed += 1
        if changed:
            with open(slide_file, "wb") as f:
                f.write(dom.toxml(encoding="utf-8"))
    return fixed


def fix_double_bullets(unpacked_dir: Path) -> int:
    slides_dir = unpacked_dir / "ppt" / "slides"
    if not slides_dir.exists():
        return 0
    fixed = 0
    for slide_file in sorted(slides_dir.glob("slide*.xml")):
        dom = defusedxml.minidom.parse(str(slide_file))
        changed = False
        for p_node in dom.getElementsByTagName("a:p"):
            ppr_nodes = [c for c in p_node.childNodes if c.nodeName == "a:pPr"]
            if not ppr_nodes:
                continue
            ppr = ppr_nodes[0]
            has_bu_char = any(c.nodeName == "a:buChar" for c in ppr.childNodes)
            if not has_bu_char:
                continue
            for r_node in p_node.getElementsByTagName("a:r"):
                t_nodes = r_node.getElementsByTagName("a:t")
                if not t_nodes or not t_nodes[0].firstChild:
                    continue
                text = t_nodes[0].firstChild.data
                new_text = BULLET_PREFIX_RE.sub("", text)
                if new_text != text:
                    t_nodes[0].firstChild.data = new_text
                    changed = True
                    fixed += 1
                break
        if changed:
            with open(slide_file, "wb") as f:
                f.write(dom.toxml(encoding="utf-8"))
    return fixed


def get_slides_in_sldidlst(unpacked_dir: Path) -> set[str]:
    """Get slide filenames referenced in presentation.xml sldIdLst."""
    pres_path = unpacked_dir / "ppt" / "presentation.xml"
    pres_rels_path = unpacked_dir / "ppt" / "_rels" / "presentation.xml.rels"

    if not pres_path.exists() or not pres_rels_path.exists():
        return set()

    # Build rId -> slide filename mapping from presentation.xml.rels
    rels_dom = defusedxml.minidom.parse(str(pres_rels_path))
    rid_to_slide = {}
    for rel in rels_dom.getElementsByTagName("Relationship"):
        rid = rel.getAttribute("Id")
        target = rel.getAttribute("Target")
        rel_type = rel.getAttribute("Type")
        if "slide" in rel_type and target.startswith("slides/"):
            rid_to_slide[rid] = target.replace("slides/", "")

    # Get rIds from sldIdLst in presentation.xml
    pres_content = pres_path.read_text(encoding="utf-8")
    referenced_rids = set(re.findall(r'<p:sldId[^>]*r:id="([^"]+)"', pres_content))

    # Return slide filenames that are in sldIdLst
    return {rid_to_slide[rid] for rid in referenced_rids if rid in rid_to_slide}


def remove_orphaned_slides(unpacked_dir: Path) -> list[str]:
    """Remove slides not referenced in sldIdLst."""
    slides_dir = unpacked_dir / "ppt" / "slides"
    slides_rels_dir = slides_dir / "_rels"
    pres_rels_path = unpacked_dir / "ppt" / "_rels" / "presentation.xml.rels"

    if not slides_dir.exists():
        return []

    referenced_slides = get_slides_in_sldidlst(unpacked_dir)
    removed = []

    # Find and remove orphaned slide files
    for slide_file in slides_dir.glob("slide*.xml"):
        if slide_file.name not in referenced_slides:
            # Remove slide file
            rel_path = slide_file.relative_to(unpacked_dir)
            slide_file.unlink()
            removed.append(str(rel_path))

            # Remove slide rels file
            rels_file = slides_rels_dir / f"{slide_file.name}.rels"
            if rels_file.exists():
                rels_file.unlink()
                removed.append(str(rels_file.relative_to(unpacked_dir)))

    # Remove relationships from presentation.xml.rels for deleted slides
    if removed and pres_rels_path.exists():
        rels_dom = defusedxml.minidom.parse(str(pres_rels_path))
        changed = False

        for rel in list(rels_dom.getElementsByTagName("Relationship")):
            target = rel.getAttribute("Target")
            if target.startswith("slides/"):
                slide_name = target.replace("slides/", "")
                if slide_name not in referenced_slides:
                    if rel.parentNode:
                        rel.parentNode.removeChild(rel)
                        changed = True

        if changed:
            with open(pres_rels_path, "wb") as f:
                f.write(rels_dom.toxml(encoding="utf-8"))

    return removed


def remove_trash_directory(unpacked_dir: Path) -> list[str]:
    """Remove [trash] directory if it exists."""
    trash_dir = unpacked_dir / "[trash]"
    removed = []

    if trash_dir.exists() and trash_dir.is_dir():
        for file_path in trash_dir.iterdir():
            if file_path.is_file():
                rel_path = file_path.relative_to(unpacked_dir)
                removed.append(str(rel_path))
                file_path.unlink()
        trash_dir.rmdir()

    return removed


def get_slide_referenced_files(unpacked_dir: Path) -> set:
    """Get files referenced directly from slides."""
    referenced = set()
    slides_rels_dir = unpacked_dir / "ppt" / "slides" / "_rels"

    if not slides_rels_dir.exists():
        return referenced

    for rels_file in slides_rels_dir.glob("*.rels"):
        dom = defusedxml.minidom.parse(str(rels_file))
        for rel in dom.getElementsByTagName("Relationship"):
            target = rel.getAttribute("Target")
            if not target:
                continue
            target_path = (rels_file.parent.parent / target).resolve()
            try:
                referenced.add(target_path.relative_to(unpacked_dir.resolve()))
            except ValueError:
                pass

    return referenced


def remove_orphaned_rels_files(unpacked_dir: Path) -> list[str]:
    """Remove .rels files for unreferenced resources."""
    resource_dirs = ["charts", "diagrams", "drawings"]
    removed = []
    slide_referenced = get_slide_referenced_files(unpacked_dir)

    for dir_name in resource_dirs:
        rels_dir = unpacked_dir / "ppt" / dir_name / "_rels"
        if not rels_dir.exists():
            continue

        for rels_file in rels_dir.glob("*.rels"):
            resource_file = rels_dir.parent / rels_file.name.replace(".rels", "")
            try:
                resource_rel_path = resource_file.resolve().relative_to(unpacked_dir.resolve())
            except ValueError:
                continue

            if not resource_file.exists() or resource_rel_path not in slide_referenced:
                rels_file.unlink()
                rel_path = rels_file.relative_to(unpacked_dir)
                removed.append(str(rel_path))

    return removed


def get_referenced_files(unpacked_dir: Path) -> set:
    """Get all files referenced in .rels files."""
    referenced = set()

    for rels_file in unpacked_dir.rglob("*.rels"):
        dom = defusedxml.minidom.parse(str(rels_file))
        for rel in dom.getElementsByTagName("Relationship"):
            target = rel.getAttribute("Target")
            if not target:
                continue
            target_path = (rels_file.parent.parent / target).resolve()
            try:
                referenced.add(target_path.relative_to(unpacked_dir.resolve()))
            except ValueError:
                pass

    return referenced


def remove_orphaned_files(unpacked_dir: Path, referenced: set) -> list[str]:
    """Remove files not in the referenced set."""
    resource_dirs = ["media", "embeddings", "charts", "diagrams", "tags", "drawings", "ink"]
    removed = []

    for dir_name in resource_dirs:
        dir_path = unpacked_dir / "ppt" / dir_name
        if not dir_path.exists():
            continue

        for file_path in dir_path.glob("*"):
            if not file_path.is_file():
                continue
            rel_path = file_path.relative_to(unpacked_dir)
            if rel_path not in referenced:
                file_path.unlink()
                removed.append(str(rel_path))

    # Clean up unreferenced theme files
    theme_dir = unpacked_dir / "ppt" / "theme"
    if theme_dir.exists():
        for file_path in theme_dir.glob("theme*.xml"):
            rel_path = file_path.relative_to(unpacked_dir)
            if rel_path not in referenced:
                file_path.unlink()
                removed.append(str(rel_path))
                # Also remove corresponding .rels
                theme_rels = theme_dir / "_rels" / f"{file_path.name}.rels"
                if theme_rels.exists():
                    theme_rels.unlink()
                    removed.append(str(theme_rels.relative_to(unpacked_dir)))

    # Remove orphaned notes slides
    notes_dir = unpacked_dir / "ppt" / "notesSlides"
    if notes_dir.exists():
        for file_path in notes_dir.glob("*.xml"):
            if not file_path.is_file():
                continue
            rel_path = file_path.relative_to(unpacked_dir)
            if rel_path not in referenced:
                file_path.unlink()
                removed.append(str(rel_path))

        notes_rels_dir = notes_dir / "_rels"
        if notes_rels_dir.exists():
            for file_path in notes_rels_dir.glob("*.rels"):
                notes_file = notes_dir / file_path.name.replace(".rels", "")
                if not notes_file.exists():
                    file_path.unlink()
                    removed.append(str(file_path.relative_to(unpacked_dir)))

    return removed


def update_content_types(unpacked_dir: Path, removed_files: list[str]) -> None:
    """Remove Content-Type overrides for deleted files."""
    ct_path = unpacked_dir / "[Content_Types].xml"
    if not ct_path.exists():
        return

    dom = defusedxml.minidom.parse(str(ct_path))
    changed = False

    for override in list(dom.getElementsByTagName("Override")):
        part_name = override.getAttribute("PartName").lstrip("/")
        if part_name in removed_files:
            if override.parentNode:
                override.parentNode.removeChild(override)
                changed = True

    if changed:
        with open(ct_path, "wb") as f:
            f.write(dom.toxml(encoding="utf-8"))


def clean_unused_files(unpacked_dir: Path) -> list[str]:
    """Remove all unreferenced files from the unpacked directory."""
    all_removed = []

    shadow_fixes = fix_shadow_overflow(unpacked_dir)
    if shadow_fixes:
        print(f"Fixed {shadow_fixes} shadow overflow value(s)")

    bullet_fixes = fix_double_bullets(unpacked_dir)
    if bullet_fixes:
        print(f"Fixed {bullet_fixes} double bullet(s) in slide text")

    # Remove orphaned slides first (not in sldIdLst)
    slides_removed = remove_orphaned_slides(unpacked_dir)
    all_removed.extend(slides_removed)

    # Remove [trash] directory
    trash_removed = remove_trash_directory(unpacked_dir)
    all_removed.extend(trash_removed)

    # Keep cleaning until nothing more is removed
    while True:
        removed_rels = remove_orphaned_rels_files(unpacked_dir)
        referenced = get_referenced_files(unpacked_dir)
        removed_files = remove_orphaned_files(unpacked_dir, referenced)

        total_removed = removed_rels + removed_files
        if not total_removed:
            break

        all_removed.extend(total_removed)

    if all_removed:
        update_content_types(unpacked_dir, all_removed)

    return all_removed


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python clean.py <unpacked_dir>", file=sys.stderr)
        print("Example: python clean.py unpacked/", file=sys.stderr)
        sys.exit(1)

    unpacked_dir = Path(sys.argv[1])

    if not unpacked_dir.exists():
        print(f"Error: {unpacked_dir} not found", file=sys.stderr)
        sys.exit(1)

    removed = clean_unused_files(unpacked_dir)

    if removed:
        print(f"Removed {len(removed)} unreferenced files:")
        for f in removed:
            print(f"  {f}")
    else:
        print("No unreferenced files found")
