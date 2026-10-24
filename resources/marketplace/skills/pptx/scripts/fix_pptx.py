#!/usr/bin/env python3
"""Post-process a generated PPTX file to fix known pptxgenjs issues.

Usage: python fix_pptx.py <input.pptx>

Fixes applied:
- Shadow parameter overflow (blurRad/dist/dir/alpha)
- Double bullet characters

The file is modified in-place.
"""

import sys
import zipfile
import tempfile
from pathlib import Path

from clean import fix_shadow_overflow, fix_double_bullets


def fix_pptx(pptx_path: Path) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        unpacked = Path(tmpdir) / "unpacked"
        with zipfile.ZipFile(pptx_path) as z:
            z.extractall(unpacked)

        shadow_fixes = fix_shadow_overflow(unpacked)
        bullet_fixes = fix_double_bullets(unpacked)

        if shadow_fixes:
            print(f"Fixed {shadow_fixes} shadow overflow value(s)")
        if bullet_fixes:
            print(f"Fixed {bullet_fixes} double bullet(s)")

        if shadow_fixes or bullet_fixes:
            with zipfile.ZipFile(pptx_path, "w", zipfile.ZIP_DEFLATED) as zout:
                for file_path in sorted(unpacked.rglob("*")):
                    if file_path.is_file():
                        zout.write(file_path, file_path.relative_to(unpacked))
            print(f"Updated {pptx_path}")
        else:
            print("No issues found")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python fix_pptx.py <input.pptx>", file=sys.stderr)
        sys.exit(1)

    pptx_path = Path(sys.argv[1])
    if not pptx_path.exists():
        print(f"Error: {pptx_path} not found", file=sys.stderr)
        sys.exit(1)

    fix_pptx(pptx_path)
