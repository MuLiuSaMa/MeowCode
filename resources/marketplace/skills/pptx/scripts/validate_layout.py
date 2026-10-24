#!/usr/bin/env python3
"""
PPTX Layout Validator - Detect layout issues in PowerPoint presentations.

This validator checks for two critical layout issues:
1. Elements exceeding slide boundaries
2. Elements overlapping with each other

Usage:
    python validate_layout.py <pptx_file> [--verbose] [--slides 3,5,8]
"""

import argparse
import io
import math
import re
import sys
import zipfile
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, List, Tuple, Dict, Set

import defusedxml.minidom
from PIL import Image


# Namespaces for OOXML
NAMESPACES = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

# EMU (English Metric Unit) conversions
# 1 inch = 914400 EMU
# 1 inch = 72 points
# 1 inch = 2.54 cm
# 1 cm = 360000 EMU
EMU_PER_INCH = 914400
EMU_PER_POINT = 12700
EMU_PER_CM = 360000


@dataclass
class BoundingBox:
    """Represents a bounding box in EMU units."""
    x: int  # Left position (EMU)
    y: int  # Top position (EMU)
    w: int  # Width (EMU)
    h: int  # Height (EMU)

    @property
    def right(self) -> int:
        return self.x + self.w

    @property
    def bottom(self) -> int:
        return self.y + self.h

    def overlaps(self, other: "BoundingBox") -> bool:
        """Check if this box overlaps with another box."""
        return (self.x < other.right and
                self.right > other.x and
                self.y < other.bottom and
                self.bottom > other.y)

    def contains(self, other: "BoundingBox") -> bool:
        return (self.x <= other.x and self.y <= other.y
                and self.right >= other.right and self.bottom >= other.bottom)

    def to_cm(self) -> Tuple[float, float, float, float]:
        """Convert to centimeters for display."""
        return (
            self.x / EMU_PER_CM,
            self.y / EMU_PER_CM,
            self.w / EMU_PER_CM,
            self.h / EMU_PER_CM
        )


@dataclass
class SlideElement:
    """Represents an element on a slide."""
    element_type: str  # "shape", "text", "image", "chart", "table", "connector"
    name: str
    bbox: BoundingBox
    xml_path: str
    line_number: int
    is_connector: bool = False
    has_text: bool = False
    is_decorative: bool = False
    # Text box internal margins (EMU)
    marL: int = 0
    marR: int = 0
    marT: int = 0
    marB: int = 0
    blip_embed_rid: str = ""
    has_opaque_fill: bool = False
    is_label_background: bool = False
    is_footer: bool = False
    line_width: int = 0
    is_line_shape: bool = False
    is_arrow: bool = False
    arrow_endpoints: Optional[Tuple[Tuple[int, int], Tuple[int, int]]] = None
    line_orig_cx: int = 0
    line_orig_cy: int = 0
    content_bbox: Optional[BoundingBox] = None
    raw_content_bbox: Optional[BoundingBox] = None
    visual_content_bbox: Optional[BoundingBox] = None
    has_norm_autofit: bool = False
    fill_color: Optional[str] = None
    fill_alpha: float = 1.0
    text_color: Optional[str] = None
    content_bbox_debug: str = ""
    content_total_lines: int = 0

    def get_effective_bbox(self) -> BoundingBox:
        """Get effective bounding box for overlap detection."""
        if self.content_bbox is not None:
            return self.content_bbox
        if self.element_type == "text" and self.has_text:
            new_x = self.bbox.x + self.marL
            new_y = self.bbox.y + self.marT
            new_w = max(0, self.bbox.w - self.marL - self.marR)
            new_h = max(0, self.bbox.h - self.marT - self.marB)
            return BoundingBox(new_x, new_y, new_w, new_h)
        else:
            return self.bbox


@dataclass
class SlideInfo:
    """Information about a single slide."""
    slide_number: int
    xml_path: str
    width: int  # Slide width in EMU
    height: int  # Slide height in EMU
    elements: List[SlideElement]


@dataclass
class LayoutIssue:
    """Represents a layout issue found on a slide."""
    issue_type: str  # "boundary", "overlap"
    slide_number: int
    description: str
    elements: List[SlideElement]
    priority: str = "P0"  # "P0" (critical) or "P1" (minor)
    details: Optional[List[str]] = None


class PPTXLayoutValidator:
    """Validator for PPTX layout issues."""

    def __init__(self, pptx_path: Optional[str] = None, verbose: bool = False, slide_filter: Optional[Set[int]] = None):
        self.pptx_path = Path(pptx_path) if pptx_path else None
        self.verbose = verbose
        self.slide_filter = slide_filter
        self.slides: List[SlideInfo] = []
        self.issues: List[LayoutIssue] = []
        self._slide_doms: Dict[str, object] = {}
        self.footer_top_y: Optional[int] = None

    def validate(self) -> bool:
        """Run all validation checks."""
        if not self.pptx_path.exists():
            print(f"Error: File not found: {self.pptx_path}", file=sys.stderr)
            return False

        if self.pptx_path.suffix.lower() != ".pptx":
            print(f"Error: Not a PPTX file: {self.pptx_path}", file=sys.stderr)
            return False

        self._extract_slide_info()
        self._detect_footer_region()

        if self.verbose:
            print(f"Found {len(self.slides)} slides")

        for slide in self.slides:
            if self.slide_filter and slide.slide_number not in self.slide_filter:
                continue
            self._check_blank_slide(slide)
            self._check_slide_boundaries(slide)
            self._check_element_overlaps(slide)
            self._check_table_content_overflow(slide)
            self._check_footer_intrusion(slide)
            self._check_word_break(slide)
            self._check_arrow_dangling(slide)
            self._check_low_contrast(slide)

        return len(self.issues) == 0

    def _find_element_by_bbox(self, slide: SlideInfo, element_type: str, bbox: BoundingBox) -> Optional[SlideElement]:
        for element in slide.elements:
            if element.element_type != element_type:
                continue
            eb = element.bbox
            if eb.x == bbox.x and eb.y == bbox.y and eb.w == bbox.w and eb.h == bbox.h:
                return element
        return None

    def _get_attr_int(self, node, attr: str, default: int = 0) -> int:
        if node and node.hasAttribute(attr):
            try:
                return int(node.getAttribute(attr))
            except Exception:
                return default
        return default

    def _extract_paragraph_text_segments(self, p_node) -> List[str]:
        segments: List[str] = [""]
        for child in p_node.childNodes:
            if child.nodeType != child.ELEMENT_NODE:
                continue
            if child.tagName == "a:br":
                segments.append("")
                continue
            if child.tagName == "a:r":
                ts = child.getElementsByTagName("a:t")
                if ts:
                    raw = "".join([t.firstChild.data for t in ts if t.firstChild and t.firstChild.nodeType == t.TEXT_NODE])
                    parts = raw.split("\n")
                    segments[-1] += parts[0]
                    for part in parts[1:]:
                        segments.append(part)
        return segments

    def _get_first_run_fonts(self, p_node) -> Tuple[str, str]:
        latin = ""
        ea = ""
        rprs = p_node.getElementsByTagName("a:rPr")
        if rprs:
            latin_nodes = rprs[0].getElementsByTagName("a:latin")
            if latin_nodes and latin_nodes[0].hasAttribute("typeface"):
                latin = latin_nodes[0].getAttribute("typeface")
            ea_nodes = rprs[0].getElementsByTagName("a:ea")
            if ea_nodes and ea_nodes[0].hasAttribute("typeface"):
                ea = ea_nodes[0].getAttribute("typeface")
        return latin, ea

    def _estimate_paragraph_line_height_pt(self, p_node, font_size_pt: float) -> float:
        base_line_height = font_size_pt * 1.2
        ppr = p_node.getElementsByTagName("a:pPr")
        if ppr:
            ln_spc = ppr[0].getElementsByTagName("a:lnSpc")
            if ln_spc:
                spc_pts = ln_spc[0].getElementsByTagName("a:spcPts")
                if spc_pts:
                    val = self._get_attr_int(spc_pts[0], "val", 0)
                    if val > 0:
                        return val / 100.0
                spc_pct = ln_spc[0].getElementsByTagName("a:spcPct")
                if spc_pct:
                    val = self._get_attr_int(spc_pct[0], "val", 0)
                    if val > 0:
                        return base_line_height * (val / 100000.0)
        text = ""
        for t_node in p_node.getElementsByTagName("a:t"):
            text += "".join(c.nodeValue or "" for c in t_node.childNodes)
        has_cjk = any(self._is_cjk_char(ch) for ch in text)
        return font_size_pt * (1.25 if has_cjk else 1.2)

    def _is_cjk_char(self, ch: str) -> bool:
        if not ch:
            return False
        code = ord(ch)
        return (
            0x4E00 <= code <= 0x9FFF
            or 0x3400 <= code <= 0x4DBF
            or 0xF900 <= code <= 0xFAFF
        )

    def _is_fullwidth_punctuation(self, ch: str) -> bool:
        if not ch:
            return False
        code = ord(ch)
        if code == 0x3000:
            return True
        if 0x3001 <= code <= 0x303F:
            return True
        if 0xFF01 <= code <= 0xFF0F:
            return True
        if 0xFF1A <= code <= 0xFF20:
            return True
        if 0xFF3B <= code <= 0xFF40:
            return True
        if 0xFF5B <= code <= 0xFF65:
            return True
        return False

    def _is_general_punctuation(self, ch: str) -> bool:
        if not ch:
            return False
        code = ord(ch)
        return 0x2000 <= code <= 0x206F

    def _estimate_avg_char_width(self, text: str, font_size_pt: float, latin_font: str) -> Tuple[float, float, str]:
        if not text:
            return font_size_pt, 1.0, "wf=1.00em"

        wf_upper = 0.65
        wf_lower = 0.48
        wf_digit = 0.56
        wf_punc = 0.28
        wf_space = 0.25
        wf_cjk = 1.05
        wf_fw_punc = 1.00
        wf_gen_punc = 0.60
        wf_symbol = 0.80

        lf = (latin_font or "").lower()
        if "arial" in lf:
            wf_upper = 0.62
            wf_lower = 0.46
            wf_digit = 0.54
            wf_punc = 0.26
            wf_gen_punc = 0.55

        n_upper = n_lower = n_digit = n_punc = n_space = n_cjk = n_fw_punc = n_gen_punc = n_sym = 0
        for ch in text:
            if ch.isspace():
                n_space += 1
            elif "0" <= ch <= "9":
                n_digit += 1
            elif ord(ch) < 128 and ch.isupper():
                n_upper += 1
            elif ord(ch) < 128 and ch.islower():
                n_lower += 1
            elif ord(ch) < 128:
                n_punc += 1
            elif self._is_fullwidth_punctuation(ch):
                n_fw_punc += 1
            elif self._is_general_punctuation(ch):
                n_gen_punc += 1
            elif self._is_cjk_char(ch):
                n_cjk += 1
            else:
                n_sym += 1

        total = n_upper + n_lower + n_digit + n_punc + n_space + n_cjk + n_fw_punc + n_gen_punc + n_sym
        if total <= 0:
            return font_size_pt, 1.0, "wf=1.00em"

        wf = (
            n_upper * wf_upper
            + n_lower * wf_lower
            + n_digit * wf_digit
            + n_punc * wf_punc
            + n_space * wf_space
            + n_cjk * wf_cjk
            + n_fw_punc * wf_fw_punc
            + n_gen_punc * wf_gen_punc
            + n_sym * wf_symbol
        ) / total

        avg_w_pt = font_size_pt * wf
        if font_size_pt >= 20:
            scale = max(1.04, 1.08 - (font_size_pt - 20) * 0.002)
            if font_size_pt > 26:
                scale -= (font_size_pt - 26) * 0.0065
                scale = max(1.02, scale)
            avg_w_pt *= scale
        elif font_size_pt >= 14:
            avg_w_pt *= 1.04
        detail = (
            f"wf={wf:.2f}em (U={n_upper},l={n_lower},d={n_digit},p={n_punc},s={n_space},"
            f"cjk={n_cjk},fwP={n_fw_punc},genP={n_gen_punc},sym={n_sym})"
        )
        return avg_w_pt, wf, detail

    def _estimate_cell_required_height_emu(self, tc_node, cell_width_emu: int) -> int:
        tc_pr = tc_node.getElementsByTagName("a:tcPr")
        marL = marR = marT = marB = 0
        if tc_pr:
            marL = self._get_attr_int(tc_pr[0], "marL", 0)
            marR = self._get_attr_int(tc_pr[0], "marR", 0)
            marT = self._get_attr_int(tc_pr[0], "marT", 0)
            marB = self._get_attr_int(tc_pr[0], "marB", 0)

        available_width_emu = max(1, cell_width_emu - marL - marR)
        available_width_pt = available_width_emu / EMU_PER_POINT

        tx_bodies = tc_node.getElementsByTagName("a:txBody")
        if not tx_bodies:
            return marT + marB

        required_height_pt = 0.0
        for tx_body in tx_bodies:
            ps = tx_body.getElementsByTagName("a:p")
            for p in ps:
                latin_font, _ea_font = self._get_first_run_fonts(p)
                sz_values: List[int] = []
                spc_values: List[int] = []
                for rpr in p.getElementsByTagName("a:rPr"):
                    if rpr.hasAttribute("sz"):
                        sz_values.append(self._get_attr_int(rpr, "sz", 0))
                    if rpr.hasAttribute("spc"):
                        spc_values.append(self._get_attr_int(rpr, "spc", 0))
                if not sz_values:
                    for epr in p.getElementsByTagName("a:endParaRPr"):
                        if epr.hasAttribute("sz"):
                            sz_values.append(self._get_attr_int(epr, "sz", 0))
                max_sz = max(sz_values) if sz_values else 900
                font_size_pt = max_sz / 100.0
                char_spc_pt = max(spc_values) / 100.0 if spc_values else 0.0

                line_height_pt = self._estimate_paragraph_line_height_pt(p, font_size_pt)

                segments = self._extract_paragraph_text_segments(p)
                total_text = "".join(segments)
                if not total_text:
                    required_height_pt += line_height_pt
                    continue

                avg_char_w_pt, _wf, _wf_detail = self._estimate_avg_char_width(total_text, font_size_pt, latin_font)
                avg_char_w_pt += char_spc_pt

                chars_per_line = max(1, int(available_width_pt / max(0.1, avg_char_w_pt)))
                lines = 0
                for seg in segments:
                    seg_len = len(seg)
                    lines += max(1, int(math.ceil(seg_len / chars_per_line)))
                required_height_pt += lines * line_height_pt

        required_height_emu = int(math.ceil(required_height_pt * EMU_PER_POINT))
        return required_height_emu + marT + marB

    def _estimate_cell_required_height_detail(self, tc_node, cell_width_emu: int, row_idx: int, col_idx: int, span: int, defined_row_h_emu: int) -> Tuple[int, List[str]]:
        tc_pr = tc_node.getElementsByTagName("a:tcPr")
        marL = marR = marT = marB = 0
        if tc_pr:
            marL = self._get_attr_int(tc_pr[0], "marL", 0)
            marR = self._get_attr_int(tc_pr[0], "marR", 0)
            marT = self._get_attr_int(tc_pr[0], "marT", 0)
            marB = self._get_attr_int(tc_pr[0], "marB", 0)

        available_width_emu = max(1, cell_width_emu - marL - marR)
        available_width_pt = available_width_emu / EMU_PER_POINT

        total_text = ""
        ascii_count = 0
        total_len = 0
        min_cpl: Optional[int] = None
        total_lines = 0
        max_font_size_pt = 0.0
        max_line_height_pt = 0.0
        latin_font = ""
        ea_font = ""
        required_height_pt = 0.0

        para_infos: List[str] = []

        tx_bodies = tc_node.getElementsByTagName("a:txBody")
        if tx_bodies:
            for tx_body in tx_bodies:
                ps = tx_body.getElementsByTagName("a:p")
                for p_idx, p in enumerate(ps, 1):
                    if not latin_font and not ea_font:
                        latin_font, ea_font = self._get_first_run_fonts(p)

                    sz_values: List[int] = []
                    spc_values: List[int] = []
                    for rpr in p.getElementsByTagName("a:rPr"):
                        if rpr.hasAttribute("sz"):
                            sz_values.append(self._get_attr_int(rpr, "sz", 0))
                        if rpr.hasAttribute("spc"):
                            spc_values.append(self._get_attr_int(rpr, "spc", 0))
                    if not sz_values:
                        for epr in p.getElementsByTagName("a:endParaRPr"):
                            if epr.hasAttribute("sz"):
                                sz_values.append(self._get_attr_int(epr, "sz", 0))
                    max_sz = max(sz_values) if sz_values else 900
                    font_size_pt = max_sz / 100.0
                    max_font_size_pt = max(max_font_size_pt, font_size_pt)
                    char_spc_pt = max(spc_values) / 100.0 if spc_values else 0.0

                    line_height_pt = self._estimate_paragraph_line_height_pt(p, font_size_pt)
                    max_line_height_pt = max(max_line_height_pt, line_height_pt)

                    segments = self._extract_paragraph_text_segments(p)
                    p_text = "".join(segments)
                    br_count = max(0, len(segments) - 1)
                    seg_lens = [len(s) for s in segments]
                    if p_text:
                        total_text += p_text
                        total_len += len(p_text)
                        ascii_count += sum(1 for ch in p_text if ord(ch) < 128)

                    if not p_text:
                        para_infos.append(
                            f"p{p_idx}: br={br_count} seg_lens={seg_lens} lines=0 p_len=0"
                        )
                        continue

                    avg_char_w_pt, wf, wf_detail = self._estimate_avg_char_width(p_text, font_size_pt, latin_font)
                    avg_char_w_pt += char_spc_pt

                    chars_per_line = max(1, int(available_width_pt / max(0.1, avg_char_w_pt)))
                    min_cpl = chars_per_line if min_cpl is None else min(min_cpl, chars_per_line)

                    lines = 0
                    for seg in segments:
                        seg_len = len(seg)
                        lines += max(1, int(math.ceil(seg_len / chars_per_line)))
                    total_lines += lines
                    required_height_pt += lines * line_height_pt
                    para_infos.append(
                        f"p{p_idx}: br={br_count} seg_lens={seg_lens} {wf_detail} avgw={avg_char_w_pt:.1f}pt cpl={chars_per_line} lines={lines} p_len={len(p_text)}"
                    )

        required_height_emu = int(math.ceil(required_height_pt * EMU_PER_POINT)) + marT + marB
        ascii_ratio_total = (ascii_count / max(1, total_len)) if total_len > 0 else 0.0
        cpl_str = str(min_cpl) if min_cpl is not None else "NA"
        font_str = f"latin={latin_font or '-'},ea={ea_font or '-'}"
        summary = (
            f"r{row_idx}c{col_idx} span={span} def_row_h={defined_row_h_emu/EMU_PER_CM:.2f}cm "
            f"req_cell_h={required_height_emu/EMU_PER_CM:.2f}cm avail_w={available_width_emu/EMU_PER_CM:.2f}cm "
            f"sz={max_font_size_pt:.1f}pt ln={max_line_height_pt:.1f}pt cpl={cpl_str} lines={total_lines} "
            f"len={total_len} ascii={ascii_ratio_total:.2f} {font_str}"
        )
        wrap_detail = ""
        if para_infos:
            shown = para_infos[:12]
            more = "" if len(para_infos) <= 12 else f" (+{len(para_infos)-12})"
            wrap_detail = "wrap=" + "; ".join(shown) + more
        details = [summary]
        if wrap_detail:
            details.append(wrap_detail)
        return required_height_emu, details

    def _get_node_bbox(self, node) -> Optional[BoundingBox]:
        xfrm = node.getElementsByTagName("a:xfrm")
        if not xfrm:
            xfrm = node.getElementsByTagName("p:xfrm")
        if not xfrm:
            return None
        xfrm = xfrm[0]
        off = xfrm.getElementsByTagName("a:off")
        ext = xfrm.getElementsByTagName("a:ext")
        if not off or not ext:
            return None
        x = self._get_attr_int(off[0], "x", 0)
        y = self._get_attr_int(off[0], "y", 0)
        w = self._get_attr_int(ext[0], "cx", 0)
        h = self._get_attr_int(ext[0], "cy", 0)
        if w <= 0 or h <= 0:
            return None
        return BoundingBox(x, y, w, h)

    def _compute_text_content_bbox(self, sp_node, element: SlideElement) -> Tuple[Optional[BoundingBox], Optional[BoundingBox], Optional[BoundingBox], str, bool]:
        avail_w_emu = max(1, element.bbox.w - element.marL - element.marR)
        avail_w_pt = avail_w_emu / EMU_PER_POINT

        tx_body = sp_node.getElementsByTagName("p:txBody")
        if not tx_body:
            tx_body = sp_node.getElementsByTagName("a:txBody")
        if not tx_body:
            return None, None, None, "no txBody", False

        body_pr = tx_body[0].getElementsByTagName("a:bodyPr")
        v_anchor = "t"
        has_norm_autofit = False
        has_sp_autofit = False
        if body_pr:
            if body_pr[0].hasAttribute("anchor"):
                v_anchor = body_pr[0].getAttribute("anchor")
            naf_elems = body_pr[0].getElementsByTagName("a:normAutofit")
            if naf_elems:
                has_norm_autofit = True
            saf_elems = body_pr[0].getElementsByTagName("a:spAutoFit")
            if saf_elems:
                has_sp_autofit = True

        algn = "l"
        pPrs = tx_body[0].getElementsByTagName("a:pPr")
        if pPrs and pPrs[0].hasAttribute("algn"):
            algn = pPrs[0].getAttribute("algn")

        ps = tx_body[0].getElementsByTagName("a:p")
        if not ps:
            return None, None, None, "no paragraphs", False

        max_line_w_pt = 0.0
        total_lines = 0
        max_font_size_pt = 0.0
        max_line_height_pt = 0.0
        latin_font = ""
        ea_font = ""
        all_text_parts: List[str] = []
        para_line_info: List[Tuple[int, float, float, float, float]] = []

        for p in ps:
            if not latin_font and not ea_font:
                latin_font, ea_font = self._get_first_run_fonts(p)

            sz_values: List[int] = []
            spc_values: List[int] = []
            for rpr in p.getElementsByTagName("a:rPr"):
                if rpr.hasAttribute("sz"):
                    sz_values.append(self._get_attr_int(rpr, "sz", 0))
                if rpr.hasAttribute("spc"):
                    spc_values.append(self._get_attr_int(rpr, "spc", 0))
            if not sz_values:
                for epr in p.getElementsByTagName("a:endParaRPr"):
                    if epr.hasAttribute("sz"):
                        sz_values.append(self._get_attr_int(epr, "sz", 0))
            max_sz = max(sz_values) if sz_values else 900
            font_size_pt = max_sz / 100.0
            max_font_size_pt = max(max_font_size_pt, font_size_pt)
            char_spc_pt = max(spc_values) / 100.0 if spc_values else 0.0

            line_height_pt = self._estimate_paragraph_line_height_pt(p, font_size_pt)
            max_line_height_pt = max(max_line_height_pt, line_height_pt)

            spc_bef_pt = 0.0
            spc_aft_pt = 0.0
            for sb in p.getElementsByTagName("a:spcBef"):
                for pts in sb.getElementsByTagName("a:spcPts"):
                    spc_bef_pt = self._get_attr_int(pts, "val", 0) / 100.0
                for pct in sb.getElementsByTagName("a:spcPct"):
                    spc_bef_pt = font_size_pt * self._get_attr_int(pct, "val", 0) / 100000.0
            for sa in p.getElementsByTagName("a:spcAft"):
                for pts in sa.getElementsByTagName("a:spcPts"):
                    spc_aft_pt = self._get_attr_int(pts, "val", 0) / 100.0
                for pct in sa.getElementsByTagName("a:spcPct"):
                    spc_aft_pt = font_size_pt * self._get_attr_int(pct, "val", 0) / 100000.0

            segments = self._extract_paragraph_text_segments(p)
            p_text = "".join(segments)
            if p_text:
                all_text_parts.append(p_text)
            if not p_text:
                total_lines += 1
                para_line_info.append((1, line_height_pt, font_size_pt, spc_bef_pt, spc_aft_pt))
                continue

            avg_char_w_pt, wf, _ = self._estimate_avg_char_width(p_text, font_size_pt, latin_font)
            avg_char_w_pt += char_spc_pt
            chars_per_line = max(1, int(avail_w_pt / max(0.1, avg_char_w_pt)))

            p_lines = 0
            for seg in segments:
                seg_len = len(seg)
                if seg_len == 0:
                    p_lines += 1
                    continue
                seg_lines = max(1, int(math.ceil(seg_len / chars_per_line)))
                p_lines += seg_lines

                if seg_len >= chars_per_line:
                    max_line_w_pt = avail_w_pt
                else:
                    seg_w_pt = seg_len * avg_char_w_pt
                    max_line_w_pt = max(max_line_w_pt, seg_w_pt)

            total_lines += p_lines
            para_line_info.append((p_lines, line_height_pt, font_size_pt, spc_bef_pt, spc_aft_pt))

        if total_lines == 0:
            return None, None, None, "no text content", False

        element.content_total_lines = total_lines

        content_h_pt = 0.0
        visual_h_pt = 0.0
        n_paras = len(para_line_info)
        for idx, (p_lines, lh_pt, fs_pt, bef_pt, aft_pt) in enumerate(para_line_info):
            is_last_para = (idx == n_paras - 1)
            if p_lines == 1 and is_last_para:
                content_h_pt += bef_pt + fs_pt + aft_pt
                visual_h_pt += bef_pt + lh_pt + aft_pt
            elif p_lines >= 2 and is_last_para:
                content_h_pt += bef_pt + (p_lines - 1) * lh_pt + fs_pt + aft_pt
                visual_h_pt += bef_pt + p_lines * lh_pt + aft_pt
            else:
                content_h_pt += bef_pt + p_lines * lh_pt + aft_pt
                visual_h_pt += bef_pt + p_lines * lh_pt + aft_pt

        content_w_emu = min(avail_w_emu, int(math.ceil(max_line_w_pt * EMU_PER_POINT)))
        content_h_emu = int(math.ceil(content_h_pt * EMU_PER_POINT))
        visual_h_emu = int(math.ceil(visual_h_pt * EMU_PER_POINT))
        raw_content_h_emu = content_h_emu

        avail_h_emu = max(0, element.bbox.h - element.marT - element.marB)
        if content_h_emu > avail_h_emu:
            content_h_emu = avail_h_emu

        content_x = element.bbox.x + element.marL
        if algn == "ctr":
            content_x += (avail_w_emu - content_w_emu) // 2
        elif algn == "r":
            content_x += avail_w_emu - content_w_emu
        content_y = element.bbox.y + element.marT
        if v_anchor == "ctr" and content_h_emu < avail_h_emu:
            content_y += (avail_h_emu - content_h_emu) // 2
        elif v_anchor == "b" and content_h_emu < avail_h_emu:
            content_y += avail_h_emu - content_h_emu

        cb = BoundingBox(content_x, content_y, content_w_emu, content_h_emu)
        raw_cb = BoundingBox(content_x, element.bbox.y + element.marT, content_w_emu, raw_content_h_emu)
        visual_cb_y = element.bbox.y + element.marT
        if v_anchor == "ctr":
            visual_cb_y += (avail_h_emu - visual_h_emu) // 2
        elif v_anchor == "b":
            visual_cb_y += avail_h_emu - visual_h_emu
        visual_cb = BoundingBox(content_x, visual_cb_y, content_w_emu, visual_h_emu)
        fill_ratio = max_line_w_pt / avail_w_pt if avail_w_pt > 0 else 1.0
        full_text = " | ".join(all_text_parts)
        if len(full_text) > 50:
            full_text = full_text[:47] + "..."
        debug = (
            f"algn={algn} lines={total_lines} sz={max_font_size_pt:.1f}pt "
            f"ln={max_line_height_pt:.1f}pt max_line_w={max_line_w_pt:.1f}pt "
            f"avail_w={avail_w_pt:.1f}pt fill={fill_ratio:.0%} "
            f'text="{full_text}"'
        )
        return cb, raw_cb, visual_cb, debug, has_norm_autofit or has_sp_autofit
    def _estimate_textbox_required_bottom_detail(self, sp_node, element: SlideElement, slide: SlideInfo) -> Tuple[int, List[str]]:
        avail_w_emu = max(1, element.bbox.w - element.marL - element.marR)
        avail_w_pt = avail_w_emu / EMU_PER_POINT

        tx_body = sp_node.getElementsByTagName("p:txBody")
        if not tx_body:
            tx_body = sp_node.getElementsByTagName("a:txBody")
        if not tx_body:
            required_total_h = element.marT + element.marB
            required_bottom = element.bbox.y + required_total_h
            summary = (
                f"textbox_content: req_h={required_total_h/EMU_PER_CM:.2f}cm req_bottom={required_bottom/EMU_PER_CM:.2f}cm "
                f"slide_h={slide.height/EMU_PER_CM:.2f}cm avail_w={avail_w_emu/EMU_PER_CM:.2f}cm (no txBody)"
            )
            return required_bottom, [summary]

        ps = tx_body[0].getElementsByTagName("a:p")

        para_infos: List[str] = []
        min_cpl: Optional[int] = None
        total_lines = 0
        total_len = 0
        ascii_count = 0
        max_font_size_pt = 0.0
        max_line_height_pt = 0.0
        latin_font = ""
        ea_font = ""
        required_height_pt = 0.0

        # Determine the last paragraph index that contains text,
        # so we can skip trailing empty paragraphs.
        last_text_para_idx = -1
        for _ti, _tp in enumerate(ps):
            _segs = self._extract_paragraph_text_segments(_tp)
            if "".join(_segs):
                last_text_para_idx = _ti

        for p_idx, p in enumerate(ps, 1):
            if not latin_font and not ea_font:
                latin_font, ea_font = self._get_first_run_fonts(p)

            sz_values: List[int] = []
            spc_values: List[int] = []
            for rpr in p.getElementsByTagName("a:rPr"):
                if rpr.hasAttribute("sz"):
                    sz_values.append(self._get_attr_int(rpr, "sz", 0))
                if rpr.hasAttribute("spc"):
                    spc_values.append(self._get_attr_int(rpr, "spc", 0))
            if not sz_values:
                for epr in p.getElementsByTagName("a:endParaRPr"):
                    if epr.hasAttribute("sz"):
                        sz_values.append(self._get_attr_int(epr, "sz", 0))
            max_sz = max(sz_values) if sz_values else 900
            font_size_pt = max_sz / 100.0
            max_font_size_pt = max(max_font_size_pt, font_size_pt)
            char_spc_pt = max(spc_values) / 100.0 if spc_values else 0.0

            line_height_pt = self._estimate_paragraph_line_height_pt(p, font_size_pt)
            max_line_height_pt = max(max_line_height_pt, line_height_pt)

            spc_bef_pt = 0.0
            spc_aft_pt = 0.0
            pPr = p.getElementsByTagName("a:pPr")
            if pPr:
                for sb in pPr[0].getElementsByTagName("a:spcBef"):
                    for pts in sb.getElementsByTagName("a:spcPts"):
                        spc_bef_pt = self._get_attr_int(pts, "val", 0) / 100.0
                    for pct in sb.getElementsByTagName("a:spcPct"):
                        spc_bef_pt = font_size_pt * self._get_attr_int(pct, "val", 0) / 100000.0
                for sa in pPr[0].getElementsByTagName("a:spcAft"):
                    for pts in sa.getElementsByTagName("a:spcPts"):
                        spc_aft_pt = self._get_attr_int(pts, "val", 0) / 100.0
                    for pct in sa.getElementsByTagName("a:spcPct"):
                        spc_aft_pt = font_size_pt * self._get_attr_int(pct, "val", 0) / 100000.0

            segments = self._extract_paragraph_text_segments(p)
            p_text = "".join(segments)
            br_count = max(0, len(segments) - 1)
            seg_lens = [len(s) for s in segments]

            if p_text:
                total_len += len(p_text)
                ascii_count += sum(1 for ch in p_text if ord(ch) < 128)

            if not p_text:
                # Non-trailing empty paragraphs occupy one line height;
                # trailing ones are skipped (PowerPoint often ignores them).
                if (p_idx - 1) < last_text_para_idx:
                    required_height_pt += line_height_pt
                para_infos.append(f"p{p_idx}: br={br_count} seg_lens={seg_lens} lines=0 p_len=0")
                continue

            avg_char_w_pt, wf, wf_detail = self._estimate_avg_char_width(p_text, font_size_pt, latin_font)
            avg_char_w_pt += char_spc_pt
            chars_per_line = max(1, int(avail_w_pt / max(0.1, avg_char_w_pt)))
            min_cpl = chars_per_line if min_cpl is None else min(min_cpl, chars_per_line)

            lines = 0
            for seg in segments:
                seg_len = len(seg)
                lines += max(1, int(math.ceil(seg_len / chars_per_line)))
            total_lines += lines
            required_height_pt += spc_bef_pt + lines * line_height_pt + spc_aft_pt

            para_infos.append(
                f"p{p_idx}: br={br_count} seg_lens={seg_lens} {wf_detail} avgw={avg_char_w_pt:.1f}pt cpl={chars_per_line} lines={lines} p_len={len(p_text)}"
            )

        required_text_h_emu = int(math.ceil(required_height_pt * EMU_PER_POINT))
        required_total_h_emu = required_text_h_emu + element.marT + element.marB
        required_bottom = element.bbox.y + required_total_h_emu

        ascii_ratio_total = (ascii_count / max(1, total_len)) if total_len > 0 else 0.0
        cpl_str = str(min_cpl) if min_cpl is not None else "NA"
        font_str = f"latin={latin_font or '-'},ea={ea_font or '-'}"
        summary = (
            f"textbox_content: req_h={required_total_h_emu/EMU_PER_CM:.2f}cm req_bottom={required_bottom/EMU_PER_CM:.2f}cm "
            f"slide_h={slide.height/EMU_PER_CM:.2f}cm avail_w={avail_w_emu/EMU_PER_CM:.2f}cm "
            f"sz={max_font_size_pt:.1f}pt ln={max_line_height_pt:.1f}pt cpl={cpl_str} lines={total_lines} len={total_len} ascii={ascii_ratio_total:.2f} {font_str}"
        )

        wrap_detail = ""
        if para_infos:
            shown = para_infos[:12]
            more = "" if len(para_infos) <= 12 else f" (+{len(para_infos)-12})"
            wrap_detail = "wrap=" + "; ".join(shown) + more

        details = [summary]
        if wrap_detail:
            details.append(wrap_detail)
        return required_bottom, details

    def _check_table_content_overflow(self, slide: SlideInfo):
        tables = [e for e in slide.elements if e.element_type == "table"]
        if not tables:
            return

        with zipfile.ZipFile(self.pptx_path, "r") as zf:
            try:
                slide_xml = zf.read(slide.xml_path)
            except KeyError:
                return
            dom = defusedxml.minidom.parseString(slide_xml)

        sp_tree = dom.getElementsByTagName("p:spTree")
        if not sp_tree:
            return

        for child in sp_tree[0].childNodes:
            if child.nodeType != child.ELEMENT_NODE:
                continue
            if child.tagName != "p:graphicFrame":
                continue
            if len(child.getElementsByTagName("a:tbl")) == 0:
                continue

            xfrm = child.getElementsByTagName("p:xfrm")
            if not xfrm:
                continue
            off = xfrm[0].getElementsByTagName("a:off")
            ext = xfrm[0].getElementsByTagName("a:ext")
            if not off or not ext:
                continue

            x = self._get_attr_int(off[0], "x", 0)
            y = self._get_attr_int(off[0], "y", 0)
            w = self._get_attr_int(ext[0], "cx", 0)
            h = self._get_attr_int(ext[0], "cy", 0)
            if w <= 0 or h <= 0:
                continue

            bbox = BoundingBox(x, y, w, h)
            element = self._find_element_by_bbox(slide, "table", bbox)
            if not element:
                continue

            tbl = child.getElementsByTagName("a:tbl")
            if not tbl:
                continue
            tbl = tbl[0]

            grid = tbl.getElementsByTagName("a:tblGrid")
            if not grid:
                continue
            cols = grid[0].getElementsByTagName("a:gridCol")
            col_widths = [self._get_attr_int(c, "w", 0) for c in cols]
            if not col_widths:
                continue

            rows = tbl.getElementsByTagName("a:tr")
            if not rows:
                continue

            row_defined_heights = [self._get_attr_int(r, "h", 0) for r in rows]
            row_required_heights: List[int] = []
            overflow_rows: List[int] = []
            overflow_details: List[Tuple[int, int, int, int, List[str]]] = []

            for r_idx, row in enumerate(rows):
                tcs = row.getElementsByTagName("a:tc")
                col_i = 0
                row_req = 0
                row_detail: List[str] = []
                row_detail_req = 0
                row_detail_col = 1
                row_detail_span = 1
                for tc in tcs:
                    span = 1
                    tc_pr = tc.getElementsByTagName("a:tcPr")
                    if tc_pr:
                        grid_span = tc_pr[0].getElementsByTagName("a:gridSpan")
                        if grid_span:
                            span = max(1, self._get_attr_int(grid_span[0], "val", 1))
                    span = min(span, max(1, len(col_widths) - col_i))
                    col_start = col_i + 1
                    cell_w = sum(col_widths[col_i:col_i + span])
                    col_i += span
                    defined_h = row_defined_heights[r_idx] if r_idx < len(row_defined_heights) else 0
                    cell_req, cell_detail = self._estimate_cell_required_height_detail(tc, cell_w, r_idx + 1, col_start, span, defined_h)
                    row_req = max(row_req, cell_req)
                    if cell_req > row_detail_req:
                        row_detail_req = cell_req
                        row_detail = cell_detail
                        row_detail_col = col_start
                        row_detail_span = span
                row_required_heights.append(row_req)
                defined_h = row_defined_heights[r_idx] if r_idx < len(row_defined_heights) else 0
                if defined_h > 0 and row_req > int(defined_h * 1.05):
                    overflow_rows.append(r_idx + 1)
                    overflow_details.append((r_idx + 1, row_detail_col, row_detail_span, row_detail_req, row_detail))

            total_defined_h = sum(row_defined_heights)
            total_required_h = sum(row_required_heights)

            defined_bottom = bbox.y + total_defined_h
            estimated_bottom = bbox.y + total_required_h
            required_bottom = max(defined_bottom, estimated_bottom)

            if required_bottom <= slide.height:
                continue

            desc_parts = []
            desc_parts.append(f"'{element.name}' (table) content may overflow beyond slide")
            desc_parts.append(f"slide_h={slide.height/EMU_PER_CM:.2f}cm, required_bottom={required_bottom/EMU_PER_CM:.2f}cm")
            desc_parts.append(f"frame_h={bbox.h/EMU_PER_CM:.2f}cm, defined_row_h={total_defined_h/EMU_PER_CM:.2f}cm, estimated_h={total_required_h/EMU_PER_CM:.2f}cm")
            if overflow_rows:
                rows_str = ", ".join(str(i) for i in overflow_rows[:30])
                more = "" if len(overflow_rows) <= 30 else f" (+{len(overflow_rows)-30})"
                desc_parts.append(f"rows_overflow={rows_str}{more}")

            overflow_details_sorted = sorted(
                overflow_details,
                key=lambda x: (x[3] - (row_defined_heights[x[0]-1] if x[0]-1 < len(row_defined_heights) else 0)),
                reverse=True
            )
            detail_lines: List[str] = []
            for d in overflow_details_sorted[:30]:
                detail_lines.extend(d[4])
            self.issues.append(LayoutIssue(
                issue_type="boundary",
                slide_number=slide.slide_number,
                description="; ".join(desc_parts),
                elements=[element],
                priority="P0",
                details=detail_lines if detail_lines else None
            ))

    def _resolve_image_path(self, zf: zipfile.ZipFile, slide_xml_path: str, embed_rid: str) -> Optional[str]:
        rels_path = slide_xml_path.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels"
        try:
            rels_xml = zf.read(rels_path)
        except KeyError:
            return None
        rels_dom = defusedxml.minidom.parseString(rels_xml)
        target = ""
        for rel in rels_dom.getElementsByTagName("Relationship"):
            if rel.getAttribute("Id") == embed_rid:
                target = rel.getAttribute("Target")
                break
        if not target:
            return None
        if target.startswith(".."):
            return "ppt/" + target[3:]
        elif target.startswith("/"):
            return target.lstrip("/")
        else:
            return "ppt/slides/" + target

    def _image_has_alpha(self, zf: zipfile.ZipFile, slide_xml_path: str, embed_rid: str) -> bool:
        img_path = self._resolve_image_path(zf, slide_xml_path, embed_rid)
        if not img_path:
            return False
        try:
            img_data = zf.read(img_path)
        except KeyError:
            return False
        try:
            img = Image.open(io.BytesIO(img_data))
            return img.mode in ("RGBA", "LA", "PA")
        except Exception:
            return False

    def _extract_slide_info(self):
        """Extract slide dimensions and elements from PPTX."""
        with zipfile.ZipFile(self.pptx_path, "r") as zf:
            pres_xml = zf.read("ppt/presentation.xml")
            pres_dom = defusedxml.minidom.parseString(pres_xml)

            sld_sz = pres_dom.getElementsByTagName("p:sldSz")
            slide_width = 10 * EMU_PER_INCH
            slide_height = 5.625 * EMU_PER_INCH
            if sld_sz:
                cx = int(sld_sz[0].getAttribute("cx"))
                cy = int(sld_sz[0].getAttribute("cy"))
                if cx > 0:
                    slide_width = cx
                if cy > 0:
                    slide_height = cy

            rels_xml = zf.read("ppt/_rels/presentation.xml.rels")
            rels_dom = defusedxml.minidom.parseString(rels_xml)
            rid_to_target: Dict[str, str] = {}
            for rel in rels_dom.getElementsByTagName("Relationship"):
                rid = rel.getAttribute("Id")
                target = rel.getAttribute("Target")
                rid_to_target[rid] = target

            sld_id_lst = pres_dom.getElementsByTagName("p:sldIdLst")
            slide_files: List[str] = []
            if sld_id_lst:
                for sld_id in sld_id_lst[0].getElementsByTagName("p:sldId"):
                    rid = sld_id.getAttributeNS(NAMESPACES["r"], "id")
                    if not rid:
                        rid = sld_id.getAttribute("r:id")
                    target = rid_to_target.get(rid, "")
                    if target:
                        if not target.startswith("ppt/"):
                            target = "ppt/" + target
                        slide_files.append(target)

            if not slide_files:
                slide_files = sorted(
                    [f for f in zf.namelist() if f.startswith("ppt/slides/slide") and f.endswith(".xml")],
                    key=lambda f: int("".join(c for c in f.split("/")[-1] if c.isdigit()) or "0")
                )

            for slide_idx, slide_file in enumerate(slide_files, 1):
                slide_xml = zf.read(slide_file)
                slide_dom = defusedxml.minidom.parseString(slide_xml)
                self._slide_doms[slide_file] = slide_dom

                elements = self._extract_elements(slide_dom, slide_file, zf)

                self.slides.append(SlideInfo(
                    slide_number=slide_idx,
                    xml_path=slide_file,
                    width=slide_width,
                    height=slide_height,
                    elements=elements
                ))

    def _extract_elements(self, dom, xml_path: str, zf: Optional[zipfile.ZipFile] = None) -> List[SlideElement]:
        """Extract all elements from a slide DOM."""
        elements = []

        sp_tree = dom.getElementsByTagName("p:spTree")
        if not sp_tree:
            return elements

        for child in sp_tree[0].childNodes:
            if child.nodeType != child.ELEMENT_NODE:
                continue

            element = self._parse_element(child, xml_path)
            if element:
                if element.element_type == "shape" and not element.has_text and not element.is_connector:
                    element.is_decorative = True
                    sp_pr = child.getElementsByTagName("p:spPr")
                    if sp_pr and sp_pr[0].getElementsByTagName("a:solidFill"):
                        if not sp_pr[0].getElementsByTagName("a:noFill"):
                            element.has_opaque_fill = True
                    if sp_pr:
                        ln_elems = sp_pr[0].getElementsByTagName("a:ln")
                        if ln_elems and ln_elems[0].getAttribute("w"):
                            try:
                                element.line_width = int(ln_elems[0].getAttribute("w"))
                            except (ValueError, TypeError):
                                pass
                            if not element.has_opaque_fill and ln_elems[0].getElementsByTagName("a:solidFill"):
                                element.has_opaque_fill = True
                elif element.name == "Empty Text Box":
                    element.is_decorative = True

                if element.element_type == "text" and element.has_text:
                    cb, raw_cb, visual_cb, debug, norm_autofit = self._compute_text_content_bbox(child, element)
                    if cb is not None:
                        element.content_bbox = cb
                        element.raw_content_bbox = raw_cb
                        element.visual_content_bbox = visual_cb
                        element.content_bbox_debug = debug
                        element.has_norm_autofit = norm_autofit

                if element.element_type == "table":
                    texts = child.getElementsByTagName("a:t")
                    all_text = "".join(
                        t.firstChild.data for t in texts if t.firstChild
                    )
                    if len(all_text) > 50:
                        all_text = all_text[:47] + "..."
                    element.content_bbox_debug = f'text="{all_text}"'

                sp_pr = child.getElementsByTagName("p:spPr")
                if sp_pr:
                    for sp_child in sp_pr[0].childNodes:
                        if sp_child.nodeName == "a:solidFill":
                            for srgb in sp_child.getElementsByTagName("a:srgbClr"):
                                element.fill_color = srgb.getAttribute("val")
                                for alpha_node in srgb.getElementsByTagName("a:alpha"):
                                    try:
                                        element.fill_alpha = int(alpha_node.getAttribute("val")) / 100000.0
                                    except (ValueError, TypeError):
                                        pass
                            break
                        elif sp_child.nodeName == "a:noFill":
                            break
                if element.has_text:
                    for rpr in child.getElementsByTagName("a:rPr"):
                        for rpr_child in rpr.childNodes:
                            if rpr_child.nodeName == "a:solidFill":
                                for srgb in rpr_child.getElementsByTagName("a:srgbClr"):
                                    element.text_color = srgb.getAttribute("val")
                                break
                        if element.text_color:
                            break

                elements.append(element)

        for idx in range(len(elements) - 1):
            cur = elements[idx]
            nxt = elements[idx + 1]
            if (cur.has_opaque_fill and cur.is_decorative
                    and nxt.has_text
                    and cur.bbox.x == nxt.bbox.x and cur.bbox.y == nxt.bbox.y
                    and cur.bbox.w == nxt.bbox.w and cur.bbox.h == nxt.bbox.h):
                cur.is_label_background = True

        return elements

    def _parse_element(self, node, xml_path: str) -> Optional[SlideElement]:
        """Parse a single element node."""
        tag_name = node.tagName

        # Determine element type
        element_type = "shape"
        name = tag_name
        is_connector = False
        has_text = False
        blip_embed_rid = ""
        marL, marR, marT, marB = 0, 0, 0, 0

        # Check for specific element types
        if tag_name == "p:sp":
            # Check if it's a text box or has a picture
            has_text = len(node.getElementsByTagName("a:t")) > 0
            has_pic = len(node.getElementsByTagName("a:blip")) > 0

            # Check if it's a text box (txBox="1")
            is_text_box = False
            cNvSpPr = node.getElementsByTagName("p:cNvSpPr")
            if cNvSpPr and cNvSpPr[0].hasAttribute("txBox"):
                if cNvSpPr[0].getAttribute("txBox") == "1":
                    is_text_box = True

            if has_pic:
                element_type = "image"
                name = "Picture"
            elif is_text_box:
                element_type = "text"
                if has_text:
                    name = "Text Box"
                else:
                    name = "Empty Text Box"
            elif has_text:
                element_type = "text"
                name = "Text Box"
            else:
                name = "Shape"

            body_pr = node.getElementsByTagName("a:bodyPr")
            if body_pr:
                bp = body_pr[0]
                marL = int(bp.getAttribute("lIns")) if bp.hasAttribute("lIns") else 91440
                marR = int(bp.getAttribute("rIns")) if bp.hasAttribute("rIns") else 91440
                marT = int(bp.getAttribute("tIns")) if bp.hasAttribute("tIns") else 45720
                marB = int(bp.getAttribute("bIns")) if bp.hasAttribute("bIns") else 45720
        elif tag_name == "p:pic":
            element_type = "image"
            name = "Picture"
            blips = node.getElementsByTagName("a:blip")
            if blips and blips[0].hasAttribute("r:embed"):
                blip_embed_rid = blips[0].getAttribute("r:embed")
        elif tag_name == "p:graphicFrame":
            # Check for chart or table
            has_chart = len(node.getElementsByTagName("c:chart")) > 0
            has_table = len(node.getElementsByTagName("a:tbl")) > 0
            # Check if it has any text (for tables with text in cells)
            has_text = len(node.getElementsByTagName("a:t")) > 0
            if has_chart:
                element_type = "chart"
                name = "Chart"
            elif has_table:
                element_type = "table"
                name = "Table"
            else:
                name = "Graphic Frame"
        elif tag_name == "p:grpSp":
            # Group shape - skip for now, could recurse
            return None
        elif tag_name == "p:cxnSp":
            element_type = "connector"
            name = "Connector"
            is_connector = True
        else:
            # Unknown element type
            return None

        # Get xfrm (transform) for position/size
        xfrm = node.getElementsByTagName("a:xfrm")
        if not xfrm:
            # For p:graphicFrame, it uses p:xfrm instead of a:xfrm
            xfrm = node.getElementsByTagName("p:xfrm")
        if not xfrm:
            return None

        xfrm = xfrm[0]

        # Get off (offset) and ext (extent)
        off = xfrm.getElementsByTagName("a:off")
        ext = xfrm.getElementsByTagName("a:ext")

        if not off or not ext:
            return None

        x = int(off[0].getAttribute("x")) if off[0].hasAttribute("x") else 0
        y = int(off[0].getAttribute("y")) if off[0].hasAttribute("y") else 0
        w = int(ext[0].getAttribute("cx")) if ext[0].hasAttribute("cx") else 0
        h = int(ext[0].getAttribute("cy")) if ext[0].hasAttribute("cy") else 0

        orig_w, orig_h = w, h
        is_line_shape = False
        if w <= 0 or h <= 0:
            ln_elems = node.getElementsByTagName("a:ln")
            ln_w = 0
            if ln_elems and ln_elems[0].hasAttribute("w"):
                try:
                    ln_w = int(ln_elems[0].getAttribute("w"))
                except ValueError:
                    pass
            if ln_w > 0:
                is_line_shape = True
                if w <= 0:
                    w = ln_w
                if h <= 0:
                    h = ln_w
            else:
                return None

        is_arrow = False
        arrow_endpoints: Optional[Tuple[Tuple[int, int], Tuple[int, int]]] = None
        if is_line_shape:
            arrow_types = ("triangle", "arrow", "stealth")
            tail_elems = node.getElementsByTagName("a:tailEnd")
            head_elems = node.getElementsByTagName("a:headEnd")
            has_tail = (tail_elems and tail_elems[0].hasAttribute("type")
                        and tail_elems[0].getAttribute("type") in arrow_types)
            has_head = (head_elems and head_elems[0].hasAttribute("type")
                        and head_elems[0].getAttribute("type") in arrow_types)
            if has_tail or has_head:
                is_arrow = True
                flipH = xfrm.getAttribute("flipH") == "1" if xfrm.hasAttribute("flipH") else False
                flipV = xfrm.getAttribute("flipV") == "1" if xfrm.hasAttribute("flipV") else False
                if flipV:
                    p1 = (x, y + orig_h)
                    p2 = (x + orig_w, y)
                elif flipH:
                    p1 = (x + orig_w, y)
                    p2 = (x, y + orig_h)
                else:
                    p1 = (x, y)
                    p2 = (x + orig_w, y + orig_h)
                arrow_endpoints = (p1, p2)

        bbox = BoundingBox(x, y, w, h)

        nv_pr = node.getElementsByTagName("p:nvPr")
        if nv_pr:
            cNvPr = nv_pr[0].getElementsByTagName("p:cNvPr")
            if cNvPr and cNvPr[0].hasAttribute("name"):
                name = cNvPr[0].getAttribute("name")

        return SlideElement(
            element_type=element_type,
            name=name,
            bbox=bbox,
            xml_path=xml_path,
            line_number=getattr(node, "sourceline", 0),
            is_connector=is_connector,
            has_text=has_text,
            is_line_shape=is_line_shape,
            is_arrow=is_arrow,
            arrow_endpoints=arrow_endpoints,
            line_orig_cx=orig_w if is_line_shape else 0,
            line_orig_cy=orig_h if is_line_shape else 0,
            marL=marL,
            marR=marR,
            marT=marT,
            marB=marB,
            blip_embed_rid=blip_embed_rid
        )

    def _check_slide_boundaries(self, slide: SlideInfo):
        """Check if any elements exceed slide boundaries."""
        margin = 0

        sp_tree = None
        dom = self._slide_doms.get(slide.xml_path)
        if dom is None and self.pptx_path:
            with zipfile.ZipFile(self.pptx_path, "r") as zf:
                try:
                    slide_xml = zf.read(slide.xml_path)
                    dom = defusedxml.minidom.parseString(slide_xml)
                except Exception:
                    dom = None
        if dom is not None:
            sp_trees = dom.getElementsByTagName("p:spTree")
            sp_tree = sp_trees[0] if sp_trees else None

        for element in slide.elements:
            if element.name == "Empty Text Box":
                continue

            bbox = element.bbox

            # Check if element is outside the safe area
            issues = []
            boundary_details: Optional[List[str]] = None
            if bbox.x < margin:
                issues.append(f"left edge at {bbox.x/EMU_PER_CM:.2f} cm (margin: {margin/EMU_PER_CM:.2f} cm)")
            if bbox.y < margin:
                issues.append(f"top edge at {bbox.y/EMU_PER_CM:.2f} cm (margin: {margin/EMU_PER_CM:.2f} cm)")
            if bbox.right > slide.width - margin:
                issues.append(f"right edge at {bbox.right/EMU_PER_CM:.2f} cm (margin: {(slide.width - margin)/EMU_PER_CM:.2f} cm)")

            bottom_edge = bbox.bottom
            bottom_label = "bottom edge"
            is_sp_autofit = False
            if element.element_type == "text" and element.has_text and sp_tree is not None:
                matched_node = None
                for child in sp_tree.childNodes:
                    if getattr(child, "tagName", None) != "p:sp":
                        continue
                    nb = self._get_node_bbox(child)
                    if nb and nb.x == bbox.x and nb.y == bbox.y and nb.w == bbox.w and nb.h == bbox.h:
                        matched_node = child
                        break
                if matched_node is not None:
                    body_pr = matched_node.getElementsByTagName("a:bodyPr")
                    has_sp_autofit = body_pr and body_pr[0].getElementsByTagName("a:spAutoFit")
                    if has_sp_autofit:
                        is_sp_autofit = True
                    estimated_bottom, boundary_details = self._estimate_textbox_required_bottom_detail(matched_node, element, slide)
                    if is_sp_autofit:
                        bottom_edge = min(estimated_bottom, bbox.bottom)
                    else:
                        bottom_edge = estimated_bottom
                    bottom_label = "content bottom edge"
                else:
                    eff = element.get_effective_bbox()
                    eff_bottom = eff.y + eff.h
                    if element.content_bbox is not None and eff_bottom > bottom_edge:
                        bottom_edge = eff_bottom
                        bottom_label = "content bottom edge"

            if bottom_edge > slide.height - margin:
                issues.append(f"{bottom_label} at {bottom_edge/EMU_PER_CM:.2f} cm (margin: {(slide.height - margin)/EMU_PER_CM:.2f} cm)")

            if issues:
                desc = f"'{element.name}' ({element.element_type}) exceeds boundary: {', '.join(issues)}"
                # Determine priority: Empty Text Box is P1, others are P0
                priority = "P1" if element.name == "Empty Text Box" else "P0"
                self.issues.append(LayoutIssue(
                    issue_type="boundary",
                    slide_number=slide.slide_number,
                    description=desc,
                    elements=[element],
                    priority=priority,
                    details=boundary_details
                ))

    def _overlap_region_is_transparent(self, img_elem: SlideElement, other_elem: SlideElement,
                                       slide_xml_path: str) -> bool:
        if not img_elem.blip_embed_rid or not self.pptx_path:
            return False
        img_bb = img_elem.bbox
        other_eff = other_elem.get_effective_bbox()
        ox1 = max(img_bb.x, other_eff.x)
        oy1 = max(img_bb.y, other_eff.y)
        ox2 = min(img_bb.x + img_bb.w, other_eff.x + other_eff.w)
        oy2 = min(img_bb.y + img_bb.h, other_eff.y + other_eff.h)
        if ox1 >= ox2 or oy1 >= oy2:
            return False
        try:
            with zipfile.ZipFile(self.pptx_path, "r") as zf:
                img_path = self._resolve_image_path(zf, slide_xml_path, img_elem.blip_embed_rid)
                if not img_path:
                    return False
                img = Image.open(io.BytesIO(zf.read(img_path)))
                if img.mode not in ("RGBA", "LA", "PA"):
                    return False
                w, h = img.size

                def _check_region(rx1, ry1, rx2, ry2):
                    cpx1 = max(0, math.floor((rx1 - img_bb.x) / img_bb.w * w))
                    cpy1 = max(0, math.floor((ry1 - img_bb.y) / img_bb.h * h))
                    cpx2 = min(w, math.ceil((rx2 - img_bb.x) / img_bb.w * w))
                    cpy2 = min(h, math.ceil((ry2 - img_bb.y) / img_bb.h * h))
                    if cpx1 >= cpx2 or cpy1 >= cpy2:
                        return 0, 0
                    crop = img.crop((cpx1, cpy1, cpx2, cpy2))
                    alpha = crop.split()[-1]
                    pixels = list(alpha.getdata())
                    total = len(pixels)
                    opaque = sum(1 for p in pixels if p >= 128)
                    return opaque, total

                opaque, total = _check_region(ox1, oy1, ox2, oy2)
                if total > 0 and (opaque / total) >= 0.02:
                    return False

                other_bb = other_elem.bbox
                fx1 = max(img_bb.x, other_bb.x)
                fy1 = max(img_bb.y, other_bb.y)
                fx2 = min(img_bb.x + img_bb.w, other_bb.x + other_bb.w)
                fy2 = min(img_bb.y + img_bb.h, other_bb.y + other_bb.h)
                if fx1 >= fx2 or fy1 >= fy2:
                    return total > 0
                opaque2, total2 = _check_region(fx1, fy1, fx2, fy2)
                if total2 > 0 and (opaque2 / total2) >= 0.02:
                    return False

                return True
        except Exception:
            return False

    def _detect_footer_region(self):
        if len(self.slides) < 3:
            return
        slide_h = self.slides[0].height
        slide_w = self.slides[0].width
        threshold_y = int(slide_h * 0.85)
        width_threshold = int(slide_w * 0.8)

        y_slide_map: Dict[int, set] = {}
        for slide in self.slides:
            for elem in slide.elements:
                if (elem.is_decorative and elem.has_opaque_fill
                        and elem.bbox.w >= width_threshold
                        and elem.bbox.y >= threshold_y):
                    y_slide_map.setdefault(elem.bbox.y, set()).add(slide.slide_number)

        min_slides = max(2, len(self.slides) // 2)
        best_y = None
        best_count = 0
        for y_val, slide_nums in y_slide_map.items():
            if len(slide_nums) >= min_slides and len(slide_nums) > best_count:
                best_count = len(slide_nums)
                best_y = y_val

        if best_y is not None:
            self.footer_top_y = best_y
            for slide in self.slides:
                footer_bottom = slide.height
                for elem in slide.elements:
                    elem_bottom = elem.bbox.y + elem.bbox.h
                    if (elem.bbox.y >= best_y
                            and elem_bottom <= footer_bottom + EMU_PER_CM * 0.1):
                        elem.is_footer = True

    def _check_footer_intrusion(self, slide: SlideInfo):
        if self.footer_top_y is None:
            return
        slide_area = slide.width * slide.height
        for elem in slide.elements:
            if elem.is_footer:
                continue
            if elem.is_decorative and not elem.has_opaque_fill:
                continue
            if elem.is_label_background:
                continue
            if elem.element_type == "image":
                img_area = elem.bbox.w * elem.bbox.h
                if img_area >= slide_area * 0.5:
                    continue
            if elem.is_decorative and elem.bbox.h >= slide.height * 0.85:
                continue
            eff = elem.get_effective_bbox()
            elem_bottom = eff.y + eff.h
            tolerance = int(EMU_PER_CM * 0.03)
            if elem_bottom > self.footer_top_y + tolerance:
                footer_cm = self.footer_top_y / EMU_PER_CM
                bottom_cm = elem_bottom / EMU_PER_CM
                self.issues.append(LayoutIssue(
                    issue_type="boundary",
                    slide_number=slide.slide_number,
                    description=(
                        f"'{elem.name}' ({elem.element_type}) intrudes into footer region: "
                        f"bottom edge at {bottom_cm:.2f} cm exceeds footer top at {footer_cm:.2f} cm"
                    ),
                    elements=[elem],
                    priority="P0"
                ))

    def _check_word_break(self, slide: SlideInfo):
        has_text = any(e.element_type == "text" and e.has_text for e in slide.elements)
        has_table = any(e.element_type == "table" for e in slide.elements)
        if not has_text and not has_table:
            return

        with zipfile.ZipFile(self.pptx_path, "r") as zf:
            try:
                slide_xml = zf.read(slide.xml_path)
            except KeyError:
                return
            dom = defusedxml.minidom.parseString(slide_xml)

        sp_tree = dom.getElementsByTagName("p:spTree")
        if not sp_tree:
            return

        reported: Set[str] = set()

        for child in sp_tree[0].childNodes:
            if child.nodeType != child.ELEMENT_NODE:
                continue

            if child.tagName == "p:sp":
                self._check_word_break_in_sp(child, slide, reported)
            elif child.tagName == "p:graphicFrame":
                self._check_word_break_in_table(child, slide, reported)

    def _check_word_break_in_paragraphs(self, ps, avail_w_pt: float, element: 'SlideElement',
                                         slide: 'SlideInfo', reported: Set[str],
                                         latin_font_hint: str = ""):
        latin_font = latin_font_hint
        ea_font = ""
        for p in ps:
            if not latin_font:
                latin_font, ea_font = self._get_first_run_fonts(p)

            sz_values: List[int] = []
            spc_values: List[int] = []
            for rpr in p.getElementsByTagName("a:rPr"):
                if rpr.hasAttribute("sz"):
                    sz_values.append(self._get_attr_int(rpr, "sz", 0))
                if rpr.hasAttribute("spc"):
                    spc_values.append(self._get_attr_int(rpr, "spc", 0))
            if not sz_values:
                for epr in p.getElementsByTagName("a:endParaRPr"):
                    if epr.hasAttribute("sz"):
                        sz_values.append(self._get_attr_int(epr, "sz", 0))
            font_size_pt = (max(sz_values) / 100.0) if sz_values else 9.0
            char_spc_pt = max(spc_values) / 100.0 if spc_values else 0.0

            segments = self._extract_paragraph_text_segments(p)
            p_text = "".join(segments)
            if not p_text:
                continue

            words = re.findall(r"[A-Za-z\u00C0-\u024F]+", p_text)
            for word in words:
                if len(word) < 4:
                    continue
                avg_char_w_pt, _, _ = self._estimate_avg_char_width(word, font_size_pt, latin_font)
                avg_char_w_pt += char_spc_pt
                tracking_pt = font_size_pt * 0.04
                word_w_pt = len(word) * avg_char_w_pt + (len(word) - 1) * tracking_pt
                if word_w_pt >= avail_w_pt:
                    report_key = f"{element.bbox.x},{element.bbox.y}:{word}"
                    if report_key in reported:
                        continue
                    reported.add(report_key)
                    self.issues.append(LayoutIssue(
                        issue_type="word_break",
                        slide_number=slide.slide_number,
                        description=(
                            f"'{element.name}' ({element.element_type}): "
                            f"word '{word}' may be broken across lines "
                            f"(estimated {word_w_pt:.1f}pt vs available {avail_w_pt:.1f}pt)"
                        ),
                        elements=[element],
                        priority="P0"
                    ))

    def _check_word_break_in_sp(self, sp_node, slide: SlideInfo, reported: Set[str]):
        tx_body = sp_node.getElementsByTagName("p:txBody")
        if not tx_body:
            return

        sp_pr = sp_node.getElementsByTagName("p:spPr")
        if not sp_pr:
            return
        xfrm = sp_pr[0].getElementsByTagName("a:xfrm")
        if not xfrm:
            return
        off_elems = xfrm[0].getElementsByTagName("a:off")
        ext_elems = xfrm[0].getElementsByTagName("a:ext")
        if not off_elems or not ext_elems:
            return
        x = self._get_attr_int(off_elems[0], "x")
        y = self._get_attr_int(off_elems[0], "y")
        w = self._get_attr_int(ext_elems[0], "cx")
        h = self._get_attr_int(ext_elems[0], "cy")
        if w <= 0 or h <= 0:
            return
        bbox = BoundingBox(x, y, w, h)

        element = self._find_element_by_bbox(slide, "text", bbox)
        if not element or not element.has_text:
            return

        body_pr = tx_body[0].getElementsByTagName("a:bodyPr")
        marL = marR = 91440
        if body_pr:
            marL = self._get_attr_int(body_pr[0], "lIns", 91440)
            marR = self._get_attr_int(body_pr[0], "rIns", 91440)
        avail_w_emu = max(1, bbox.w - marL - marR)
        avail_w_pt = avail_w_emu / EMU_PER_POINT

        ps = tx_body[0].getElementsByTagName("a:p")
        self._check_word_break_in_paragraphs(ps, avail_w_pt, element, slide, reported)

    def _check_word_break_in_table(self, gf_node, slide: SlideInfo, reported: Set[str]):
        tbl_nodes = gf_node.getElementsByTagName("a:tbl")
        if not tbl_nodes:
            return

        xfrm = gf_node.getElementsByTagName("p:xfrm")
        if not xfrm:
            return
        off_elems = xfrm[0].getElementsByTagName("a:off")
        ext_elems = xfrm[0].getElementsByTagName("a:ext")
        if not off_elems or not ext_elems:
            return
        tbl_x = self._get_attr_int(off_elems[0], "x")
        tbl_y = self._get_attr_int(off_elems[0], "y")
        tbl_w = self._get_attr_int(ext_elems[0], "cx")
        tbl_h = self._get_attr_int(ext_elems[0], "cy")
        if tbl_w <= 0 or tbl_h <= 0:
            return
        tbl_bbox = BoundingBox(tbl_x, tbl_y, tbl_w, tbl_h)

        element = self._find_element_by_bbox(slide, "table", tbl_bbox)
        if not element:
            return

        tbl = tbl_nodes[0]
        grid_cols = tbl.getElementsByTagName("a:gridCol")
        col_widths = [self._get_attr_int(gc, "w", 0) for gc in grid_cols]
        if not col_widths:
            return

        for tr in tbl.childNodes:
            if tr.nodeType != tr.ELEMENT_NODE or tr.tagName != "a:tr":
                continue
            col_idx = 0
            for tc in tr.childNodes:
                if tc.nodeType != tc.ELEMENT_NODE or tc.tagName != "a:tc":
                    continue
                grid_span = int(tc.getAttribute("gridSpan")) if tc.hasAttribute("gridSpan") else 1
                cell_w = sum(col_widths[col_idx:col_idx + grid_span])

                tc_pr = tc.getElementsByTagName("a:tcPr")
                cell_marL = 91440
                cell_marR = 91440
                if tc_pr:
                    cell_marL = self._get_attr_int(tc_pr[0], "marL", 91440)
                    cell_marR = self._get_attr_int(tc_pr[0], "marR", 91440)
                avail_w_emu = max(1, cell_w - cell_marL - cell_marR)
                avail_w_pt = avail_w_emu / EMU_PER_POINT

                ps = tc.getElementsByTagName("a:p")
                self._check_word_break_in_paragraphs(ps, avail_w_pt, element, slide, reported)

                col_idx += grid_span

    @staticmethod
    def _hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
        h = hex_color.lstrip("#")
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

    @staticmethod
    def _relative_luminance(r: int, g: int, b: int) -> float:
        rs, gs, bs = r / 255.0, g / 255.0, b / 255.0
        def linearize(c: float) -> float:
            return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        return 0.2126 * linearize(rs) + 0.7152 * linearize(gs) + 0.0722 * linearize(bs)

    def _contrast_ratio(self, hex1: str, hex2: str) -> float:
        l1 = self._relative_luminance(*self._hex_to_rgb(hex1))
        l2 = self._relative_luminance(*self._hex_to_rgb(hex2))
        lighter = max(l1, l2)
        darker = min(l1, l2)
        return (lighter + 0.05) / (darker + 0.05)

    def _check_blank_slide(self, slide: SlideInfo):
        if len(slide.elements) == 0:
            self.issues.append(LayoutIssue(
                issue_type="blank_slide",
                slide_number=slide.slide_number,
                description=f"Slide {slide.slide_number} is blank — no shapes, text, or images in spTree. This is a generation defect; add content to this slide",
                elements=[],
                priority="P0"
            ))

    def _check_low_contrast(self, slide: SlideInfo):
        MIN_CONTRAST = 1.3
        for idx, elem in enumerate(slide.elements):
            if not elem.has_text or not elem.text_color or elem.element_type != "text":
                continue
            bg_color = elem.fill_color
            bg_alpha = elem.fill_alpha
            if not bg_color:
                for j in range(idx - 1, -1, -1):
                    behind = slide.elements[j]
                    if behind.fill_color and behind.bbox.contains(elem.bbox):
                        bg_color = behind.fill_color
                        bg_alpha = behind.fill_alpha
                        break
            if not bg_color:
                continue
            if bg_alpha < 1.0:
                fg = self._hex_to_rgb(bg_color)
                blended = tuple(int(fg[c] * bg_alpha + 255 * (1 - bg_alpha)) for c in range(3))
                bg_color = f"{blended[0]:02X}{blended[1]:02X}{blended[2]:02X}"
            ratio = self._contrast_ratio(elem.text_color, bg_color)
            if ratio < MIN_CONTRAST:
                self.issues.append(LayoutIssue(
                    issue_type="low_contrast",
                    slide_number=slide.slide_number,
                    description=(
                        f"'{elem.name}' text color #{elem.text_color} on "
                        f"background #{bg_color} has low contrast "
                        f"(ratio {ratio:.1f}:1, minimum {MIN_CONTRAST}:1)"
                    ),
                    elements=[elem],
                    priority="P0"
                ))

    def _check_arrow_dangling(self, slide: SlideInfo):
        TOLERANCE = 72000
        arrows = [e for e in slide.elements if e.is_arrow and e.arrow_endpoints]
        if not arrows:
            return
        non_arrows = [e for e in slide.elements if not e.is_arrow and not e.is_connector]

        geo_bboxes: List[Tuple[int, int, int, int]] = []
        for elem in non_arrows:
            if elem.is_line_shape and (elem.line_orig_cx != 0 or elem.line_orig_cy != 0):
                bx = elem.bbox.x
                by = elem.bbox.y
                cx = elem.line_orig_cx
                cy = elem.line_orig_cy
                x1 = min(bx, bx + cx)
                y1 = min(by, by + cy)
                x2 = max(bx, bx + cx)
                y2 = max(by, by + cy)
                ln_w = elem.bbox.w if elem.line_orig_cx == 0 else elem.bbox.h
                if x1 == x2:
                    x1 -= ln_w // 2
                    x2 += ln_w // 2
                if y1 == y2:
                    y1 -= ln_w // 2
                    y2 += ln_w // 2
            else:
                x1, y1 = elem.bbox.x, elem.bbox.y
                x2, y2 = elem.bbox.x + elem.bbox.w, elem.bbox.y + elem.bbox.h
            geo_bboxes.append((x1, y1, x2, y2))

        for arrow in arrows:
            p1, p2 = arrow.arrow_endpoints
            dangling = []
            for label, pt in [("head", p1), ("tail", p2)]:
                px, py = pt
                found = False
                for ex1, ey1, ex2, ey2 in geo_bboxes:
                    in_x = (ex1 - TOLERANCE) <= px <= (ex2 + TOLERANCE)
                    in_y = (ey1 - TOLERANCE) <= py <= (ey2 + TOLERANCE)
                    if not (in_x and in_y):
                        continue
                    near_edge = (abs(px - ex1) <= TOLERANCE or abs(px - ex2) <= TOLERANCE
                                 or abs(py - ey1) <= TOLERANCE or abs(py - ey2) <= TOLERANCE)
                    if near_edge:
                        found = True
                        break
                if not found:
                    dangling.append(label)
            if dangling:
                ends = " and ".join(dangling)
                self.issues.append(LayoutIssue(
                    issue_type="arrow_dangling",
                    slide_number=slide.slide_number,
                    description=f"'{arrow.name}' arrow has dangling {ends} endpoint(s)",
                    elements=[arrow],
                    priority="P0"
                ))

    def _check_element_overlaps(self, slide: SlideInfo):
        """Check for overlapping elements.

        Strategy:
        - Connector ↔ Connector: Ignore
        - Decorative (no-text Shape / Empty Text Box) ↔ Any: Ignore
        - Content elements: Use text content bbox for Text Box, original bbox for others
        """
        if len(slide.elements) < 2:
            return

        checked_pairs = set()

        occluded_candidates: Dict[Tuple[int, int], Tuple[SlideElement, SlideElement]] = {}
        overflow_candidates: Dict[int, Tuple[int, SlideElement, SlideElement, int]] = {}

        for i, elem1 in enumerate(slide.elements):
            for j, elem2 in enumerate(slide.elements):
                if i >= j:
                    continue

                pair_key = tuple(sorted([i, j]))
                if pair_key in checked_pairs:
                    continue
                checked_pairs.add(pair_key)

                if elem1.is_connector and elem2.is_connector:
                    continue
                if elem1.is_arrow or elem2.is_arrow:
                    continue
                if elem1.is_footer and elem2.is_footer:
                    continue
                if elem1.is_decorative or elem2.is_decorative:
                    if (elem1.is_line_shape or elem2.is_line_shape) and elem1.is_decorative and elem2.is_decorative:
                        continue
                    if (elem1.is_decorative and elem1.has_opaque_fill
                            and elem2.is_decorative and elem2.has_opaque_fill):
                        bordered = None
                        other = None
                        if elem1.line_width > 0 and i < j:
                            bordered, other = elem1, elem2
                        elif elem2.line_width > 0 and j < i:
                            bordered, other = elem2, elem1
                        if bordered and other:
                            bb = bordered.bbox
                            ob = other.bbox
                            if not (ob.x >= bb.x and ob.y >= bb.y
                                    and ob.right <= bb.right and ob.bottom <= bb.bottom):
                                half_lw = bordered.line_width // 2
                                expanded = BoundingBox(
                                    bb.x - half_lw,
                                    bb.y - half_lw,
                                    bb.w + bordered.line_width,
                                    bb.h + bordered.line_width,
                                )
                                if expanded.overlaps(ob):
                                    self.issues.append(LayoutIssue(
                                        issue_type="overlap",
                                        slide_number=slide.slide_number,
                                        description=(
                                            f"'{bordered.name}' border occluded by "
                                            f"'{other.name}' (adjacent opaque shapes, gap < border width)"
                                        ),
                                        elements=[bordered, other],
                                        priority="P0"
                                    ))
                        continue

                    content_elem = None
                    shape_elem = None
                    shape_idx = -1
                    content_idx = -1
                    if elem1.is_decorative and elem1.has_opaque_fill and not elem2.is_decorative and elem2.has_text:
                        shape_elem, shape_idx = elem1, i
                        content_elem, content_idx = elem2, j
                    elif elem2.is_decorative and elem2.has_opaque_fill and not elem1.is_decorative and elem1.has_text:
                        shape_elem, shape_idx = elem2, j
                        content_elem, content_idx = elem1, i

                    if shape_elem and content_elem:
                        is_label_pair = (shape_elem.is_label_background
                                and content_elem.bbox.x == shape_elem.bbox.x
                                and content_elem.bbox.y == shape_elem.bbox.y
                                and content_elem.bbox.w == shape_elem.bbox.w
                                and content_elem.bbox.h == shape_elem.bbox.h)
                        if is_label_pair:
                            continue

                    if shape_elem and content_elem and shape_idx > content_idx:
                        if shape_elem.is_label_background:
                            is_own_label = (content_elem.bbox.x == shape_elem.bbox.x
                                    and content_elem.bbox.y == shape_elem.bbox.y
                                    and content_elem.bbox.w == shape_elem.bbox.w
                                    and content_elem.bbox.h == shape_elem.bbox.h)
                            if is_own_label:
                                continue
                        content_eff = content_elem.get_effective_bbox()
                        shape_bb = shape_elem.bbox
                        is_occluded = content_eff.overlaps(shape_bb)
                        if not is_occluded and content_elem.raw_content_bbox is not None:
                            raw_eff = content_elem.raw_content_bbox
                            if raw_eff.bottom > content_elem.bbox.bottom and content_elem.bbox.overlaps(shape_bb):
                                is_occluded = True
                        if is_occluded:
                            occluded_candidates[(content_idx, shape_idx)] = (content_elem, shape_elem)

                    if shape_elem and content_elem and shape_idx < content_idx:
                        text_bb = content_elem.bbox
                        shape_bb = shape_elem.bbox
                        text_inside_shape = (text_bb.x >= shape_bb.x and text_bb.y >= shape_bb.y
                                and text_bb.right <= shape_bb.right
                                and text_bb.bottom <= shape_bb.bottom)
                        # Also treat as "inside" when top/left/right are within shape
                        # but bottom slightly exceeds (text meant to be in card but overflows).
                        # Guard: the text must have layout siblings (other text elements
                        # fully inside the shape with a similar x coordinate), proving it
                        # belongs to the card's content rather than being an independent
                        # label (e.g. a page number) placed near the card edge.
                        text_mostly_inside = False
                        if (not text_inside_shape
                                and text_bb.x >= shape_bb.x and text_bb.y >= shape_bb.y
                                and text_bb.right <= shape_bb.right
                                and text_bb.bottom > shape_bb.bottom):
                            overlap_h = shape_bb.bottom - text_bb.y
                            if overlap_h > 0:
                                # Check for layout siblings inside the shape
                                x_tolerance = 36000  # ~0.1cm
                                has_sibling = False
                                for k, other_elem in enumerate(slide.elements):
                                    if k == content_idx or k == shape_idx:
                                        continue
                                    if not other_elem.has_text or other_elem.is_decorative:
                                        continue
                                    ob = other_elem.bbox
                                    fully_inside = (ob.x >= shape_bb.x and ob.y >= shape_bb.y
                                                    and ob.right <= shape_bb.right
                                                    and ob.bottom <= shape_bb.bottom)
                                    if fully_inside and abs(ob.x - text_bb.x) <= x_tolerance:
                                        has_sibling = True
                                        break
                                if has_sibling:
                                    text_mostly_inside = True
                        if text_inside_shape or text_mostly_inside:
                            shape_area = shape_bb.w * shape_bb.h
                            text_area = text_bb.w * text_bb.h
                            if text_area > 0 and shape_area >= text_area * 1.2:
                                raw_eff = content_elem.raw_content_bbox or content_elem.get_effective_bbox()
                                if raw_eff.bottom > shape_bb.bottom:
                                    overflow_emu = raw_eff.bottom - shape_bb.bottom
                                    prev = overflow_candidates.get(content_idx)
                                    if prev is None or shape_area < prev[0]:
                                        overflow_candidates[content_idx] = (shape_area, content_elem, shape_elem, overflow_emu)
                        else:
                            if shape_bb.w < 91440 or shape_bb.h < 91440:
                                pass
                            elif shape_bb.w > 5486400:
                                pass
                            else:
                                content_eff = content_elem.get_effective_bbox()
                                if shape_bb.contains(content_eff):
                                    pass
                                elif content_eff.overlaps(shape_bb):
                                    raw_x1 = max(content_elem.bbox.x, shape_bb.x)
                                    raw_x2 = min(content_elem.bbox.right, shape_bb.right)
                                    raw_h_overlap_pct = ((raw_x2 - raw_x1) / shape_bb.w * 100) if shape_bb.w > 0 and raw_x2 > raw_x1 else 0
                                    if raw_h_overlap_pct > 50:
                                        pass
                                    else:
                                        ov_x1 = max(content_eff.x, shape_bb.x)
                                        ov_y1 = max(content_eff.y, shape_bb.y)
                                        ov_x2 = min(content_eff.right, shape_bb.right)
                                        ov_y2 = min(content_eff.bottom, shape_bb.bottom)
                                        ov_area = (ov_x2 - ov_x1) * (ov_y2 - ov_y1)
                                        shape_area_v = shape_bb.w * shape_bb.h
                                        ov_pct_shape = (ov_area / shape_area_v * 100) if shape_area_v > 0 else 0
                                        if ov_pct_shape > 10:
                                            content_area = content_eff.w * content_eff.h
                                            ov_pct_content = (ov_area / content_area * 100) if content_area > 0 else 0
                                            self.issues.append(LayoutIssue(
                                                issue_type="overlap",
                                                slide_number=slide.slide_number,
                                                description=(
                                                    f"'{content_elem.name}' ({content_elem.element_type}) overlaps with "
                                                    f"decorative '{shape_elem.name}' "
                                                    f"(overlap: {ov_pct_content:.1f}% / {ov_pct_shape:.1f}%)"
                                                ),
                                                elements=[content_elem, shape_elem],
                                                priority="P0"
                                            ))
                    continue

                bbox1 = elem1.get_effective_bbox()
                bbox2 = elem2.get_effective_bbox()

                if bbox1.overlaps(bbox2):
                    if elem1.element_type == "image" and elem2.has_text and i < j:
                        continue
                    if elem2.element_type == "image" and elem1.has_text and j < i:
                        continue
                    if elem1.element_type == "image" and self._overlap_region_is_transparent(elem1, elem2, slide.xml_path):
                        continue
                    if elem2.element_type == "image" and self._overlap_region_is_transparent(elem2, elem1, slide.xml_path):
                        continue

                    overlap_x1 = max(bbox1.x, bbox2.x)
                    overlap_y1 = max(bbox1.y, bbox2.y)
                    overlap_x2 = min(bbox1.right, bbox2.right)
                    overlap_y2 = min(bbox1.bottom, bbox2.bottom)

                    overlap_w = overlap_x2 - overlap_x1
                    overlap_h = overlap_y2 - overlap_y1
                    overlap_area = overlap_w * overlap_h

                    elem1_area = bbox1.w * bbox1.h
                    elem2_area = bbox2.w * bbox2.h

                    overlap_pct1 = (overlap_area / elem1_area) * 100 if elem1_area > 0 else 0
                    overlap_pct2 = (overlap_area / elem2_area) * 100 if elem2_area > 0 else 0

                    if overlap_pct1 > 5 or overlap_pct2 > 5:
                        desc = (f"'{elem1.name}' ({elem1.element_type}) overlaps with "
                               f"'{elem2.name}' ({elem2.element_type}) "
                               f"(overlap: {overlap_pct1:.1f}% / {overlap_pct2:.1f}%)")
                        priority = "P0"
                        self.issues.append(LayoutIssue(
                            issue_type="overlap",
                            slide_number=slide.slide_number,
                            description=desc,
                            elements=[elem1, elem2],
                            priority=priority
                        ))
                else:
                    if elem1.has_text and elem2.has_text:
                        vcb1 = elem1.visual_content_bbox
                        vcb2 = elem2.visual_content_bbox
                        b1 = elem1.bbox
                        b2 = elem2.bbox
                        vert_gap = max(0, max(b2.y - b1.bottom, b1.y - b2.bottom))
                        horz_overlap = b1.x < b2.right and b2.x < b1.right
                        if vert_gap <= 72000 and horz_overlap:
                            overflows1 = (vcb1 is not None and not elem1.has_norm_autofit
                                          and (vcb1.bottom > b1.bottom or vcb1.y < b1.y))
                            overflows2 = (vcb2 is not None and not elem2.has_norm_autofit
                                          and (vcb2.bottom > b2.bottom or vcb2.y < b2.y))
                            if overflows1 and vcb1.overlaps(bbox2):
                                self.issues.append(LayoutIssue(
                                    issue_type="overlap",
                                    slide_number=slide.slide_number,
                                    description=(
                                        f"'{elem1.name}' (text) content overflows into "
                                        f"'{elem2.name}' (text)"
                                    ),
                                    elements=[elem1, elem2],
                                    priority="P0"
                                ))
                                continue
                            if overflows2 and vcb2.overlaps(bbox1):
                                self.issues.append(LayoutIssue(
                                    issue_type="overlap",
                                    slide_number=slide.slide_number,
                                    description=(
                                        f"'{elem2.name}' (text) content overflows into "
                                        f"'{elem1.name}' (text)"
                                    ),
                                    elements=[elem2, elem1],
                                    priority="P0"
                                ))
                                continue

        for (content_idx, shape_idx), (content_elem, shape_elem) in occluded_candidates.items():
            self.issues.append(LayoutIssue(
                issue_type="overlap",
                slide_number=slide.slide_number,
                description=(
                    f"'{content_elem.name}' ({content_elem.element_type}) occluded by "
                    f"'{shape_elem.name}' ({shape_elem.element_type})"
                ),
                elements=[content_elem, shape_elem],
                priority="P0"
            ))

        for content_idx, (shape_area, content_elem, shape_elem, overflow_emu) in overflow_candidates.items():
            self.issues.append(LayoutIssue(
                issue_type="overflow",
                slide_number=slide.slide_number,
                description=(
                    f"'{content_elem.name}' ({content_elem.element_type}) "
                    f"content overflows container '{shape_elem.name}' "
                    f"by {overflow_emu / EMU_PER_CM:.2f}cm at bottom"
                ),
                elements=[content_elem, shape_elem],
                priority="P0"
            ))

    def get_report(self) -> str:
        import io
        buf = io.StringIO()
        self._write_report(buf)
        return buf.getvalue()

    def print_report(self):
        self._write_report(sys.stdout)

    def _write_report(self, out):
        import builtins
        def print(*args, **kwargs):
            kwargs.setdefault("file", out)
            builtins.print(*args, **kwargs)
        def md_escape(text: str) -> str:
            return (text.replace("\\", "\\\\")
                        .replace("|", "\\|")
                        .replace("\n", "<br>")
                        .strip())

        def print_md_table(headers: List[str], rows: List[List[str]]):
            print("| " + " | ".join(headers) + " |")
            print("| " + " | ".join(["---"] * len(headers)) + " |")
            for row in rows:
                print("| " + " | ".join(row) + " |")
            print()

        print("# PPTX Layout Validation Report")
        print()
        print(f"- File: {self.pptx_path}")
        print(f"- Issues: {len(self.issues)}")
        print()

        if not self.issues:
            print("无问题。")
            return

        issues_by_slide: Dict[int, List[LayoutIssue]] = {}
        for issue in self.issues:
            issues_by_slide.setdefault(issue.slide_number, []).append(issue)

        for slide in self.slides:
            slide_num = slide.slide_number
            if self.slide_filter and slide_num not in self.slide_filter:
                continue
            print(f"## Slide {slide_num}")
            print()

            slide_issues = issues_by_slide.get(slide_num, [])
            if not slide_issues:
                print("无问题。")
                print()
                continue

            boundary_issues = [issue for issue in slide_issues if issue.issue_type == "boundary"]
            overlap_issues = [issue for issue in slide_issues if issue.issue_type == "overlap"]
            overflow_issues = [issue for issue in slide_issues if issue.issue_type == "overflow"]
            word_break_issues = [issue for issue in slide_issues if issue.issue_type == "word_break"]
            arrow_dangling_issues = [issue for issue in slide_issues if issue.issue_type == "arrow_dangling"]
            low_contrast_issues = [issue for issue in slide_issues if issue.issue_type == "low_contrast"]

            if boundary_issues:
                print("### 边界问题")
                print()
                rows: List[List[str]] = []
                for idx, issue in enumerate(boundary_issues, 1):
                    detailed_info = []
                    for elem in issue.elements:
                        orig_x, orig_y, orig_w, orig_h = elem.bbox.to_cm()
                        eff_bbox = elem.get_effective_bbox()
                        eff_x, eff_y, eff_w, eff_h = eff_bbox.to_cm()
                        detailed_info.append((
                            f"{elem.name} @ (x={orig_x:.2f}, y={orig_y:.2f}, w={orig_w:.2f}, h={orig_h:.2f}) cm",
                            f"{elem.name} @ (x={eff_x:.2f}, y={eff_y:.2f}, w={eff_w:.2f}, h={eff_h:.2f}) cm"
                        ))

                    desc = issue.description
                    if issue.elements:
                        desc = desc.replace(f"'{issue.elements[0].name}' ({issue.elements[0].element_type}) ", "")

                    orig_info = "; ".join([i[0] for i in detailed_info])
                    eff_info = "; ".join([i[1] for i in detailed_info])
                    detail = f"文本框位置：{orig_info}<br>有效文本位置：{eff_info}"
                    if issue.details:
                        detail += "<br>诊断：<br>" + "<br>".join([md_escape(d) for d in issue.details])
                    else:
                        debug_parts = [f"{e.name}: {e.content_bbox_debug}" for e in issue.elements if e.content_bbox_debug]
                        if debug_parts:
                            detail += "<br>诊断：" + "; ".join(debug_parts)

                    rows.append([
                        str(idx),
                        md_escape(issue.priority),
                        md_escape(desc),
                        md_escape(detail),
                    ])
                print_md_table(["序号", "优先级", "问题描述", "详细信息"], rows)

            if overlap_issues:
                print("### 重叠问题")
                print()
                rows = []
                for idx, issue in enumerate(overlap_issues, 1):
                    match = re.search(r"\(overlap: ([\d.]+)% / ([\d.]+)%\)", issue.description)
                    overlap_pct = f"{match.group(1)}%/{match.group(2)}%" if match else ""
                    desc = f"{issue.elements[0].name} ↔ {issue.elements[1].name} {overlap_pct}".strip()

                    elem_orig_details = []
                    elem_eff_details = []
                    elem_debug_parts = []
                    for elem in issue.elements:
                        orig_bbox = elem.bbox
                        orig_x, orig_y, orig_w, orig_h = orig_bbox.to_cm()
                        elem_orig_details.append(f"{elem.name} @ (x={orig_x:.2f}, y={orig_y:.2f}, w={orig_w:.2f}, h={orig_h:.2f}) cm")

                        eff_bbox = elem.get_effective_bbox()
                        eff_x, eff_y, eff_w, eff_h = eff_bbox.to_cm()
                        elem_eff_details.append(f"{elem.name} @ (x={eff_x:.2f}, y={eff_y:.2f}, w={eff_w:.2f}, h={eff_h:.2f}) cm")

                        if elem.content_bbox_debug:
                            elem_debug_parts.append(f"{elem.name}: {elem.content_bbox_debug}")

                    orig_info = "; ".join(elem_orig_details)
                    eff_info = "; ".join(elem_eff_details)
                    detail = f"文本框位置：{orig_info}<br>有效文本位置：{eff_info}"
                    if elem_debug_parts:
                        detail += "<br>诊断：" + "; ".join(elem_debug_parts)
                    rows.append([str(idx), md_escape(issue.priority), md_escape(desc), md_escape(detail)])

                print_md_table(["序号", "优先级", "问题描述", "详细信息"], rows)

            if overflow_issues:
                print("### 溢出问题")
                print()
                rows = []
                for idx, issue in enumerate(overflow_issues, 1):
                    elem_orig_details = []
                    elem_eff_details = []
                    elem_debug_parts = []
                    for elem in issue.elements:
                        orig_bbox = elem.bbox
                        orig_x, orig_y, orig_w, orig_h = orig_bbox.to_cm()
                        elem_orig_details.append(f"{elem.name} @ (x={orig_x:.2f}, y={orig_y:.2f}, w={orig_w:.2f}, h={orig_h:.2f}) cm")

                        eff_bbox = elem.get_effective_bbox()
                        eff_x, eff_y, eff_w, eff_h = eff_bbox.to_cm()
                        elem_eff_details.append(f"{elem.name} @ (x={eff_x:.2f}, y={eff_y:.2f}, w={eff_w:.2f}, h={eff_h:.2f}) cm")

                        if elem.content_bbox_debug:
                            elem_debug_parts.append(f"{elem.name}: {elem.content_bbox_debug}")

                    orig_info = "; ".join(elem_orig_details)
                    eff_info = "; ".join(elem_eff_details)
                    detail = f"文本框位置：{orig_info}<br>有效文本位置：{eff_info}"
                    if elem_debug_parts:
                        detail += "<br>诊断：" + "; ".join(elem_debug_parts)
                    rows.append([str(idx), md_escape(issue.priority), md_escape(issue.description), md_escape(detail)])

                print_md_table(["序号", "优先级", "问题描述", "详细信息"], rows)

            if word_break_issues:
                print("### 单词折行问题")
                print()
                rows = []
                for idx, issue in enumerate(word_break_issues, 1):
                    elem_orig_details = []
                    elem_debug_parts = []
                    for elem in issue.elements:
                        orig_bbox = elem.bbox
                        orig_x, orig_y, orig_w, orig_h = orig_bbox.to_cm()
                        elem_orig_details.append(f"{elem.name} @ (x={orig_x:.2f}, y={orig_y:.2f}, w={orig_w:.2f}, h={orig_h:.2f}) cm")
                        if elem.content_bbox_debug:
                            elem_debug_parts.append(f"{elem.name}: {elem.content_bbox_debug}")

                    orig_info = "; ".join(elem_orig_details)
                    detail = f"文本框位置：{orig_info}"
                    if elem_debug_parts:
                        detail += "<br>诊断：" + "; ".join(elem_debug_parts)
                    rows.append([str(idx), md_escape(issue.priority), md_escape(issue.description), md_escape(detail)])

                print_md_table(["序号", "优先级", "问题描述", "详细信息"], rows)

            if arrow_dangling_issues:
                print("### 箭头端点悬空问题")
                print()
                rows = []
                for idx, issue in enumerate(arrow_dangling_issues, 1):
                    elem = issue.elements[0]
                    orig_x, orig_y, orig_w, orig_h = elem.bbox.to_cm()
                    detail = f"{elem.name} @ (x={orig_x:.2f}, y={orig_y:.2f}, w={orig_w:.2f}, h={orig_h:.2f}) cm"
                    if elem.arrow_endpoints:
                        emu = 360000
                        p1, p2 = elem.arrow_endpoints
                        detail += f"<br>head=({p1[0]/emu:.2f}, {p1[1]/emu:.2f}), tail=({p2[0]/emu:.2f}, {p2[1]/emu:.2f}) cm"
                    rows.append([str(idx), md_escape(issue.priority), md_escape(issue.description), md_escape(detail)])

                print_md_table(["序号", "优先级", "问题描述", "详细信息"], rows)

            if low_contrast_issues:
                print("### 对比度不足问题")
                print()
                rows = []
                for idx, issue in enumerate(low_contrast_issues, 1):
                    elem = issue.elements[0]
                    orig_x, orig_y, orig_w, orig_h = elem.bbox.to_cm()
                    detail = f"{elem.name} @ (x={orig_x:.2f}, y={orig_y:.2f}, w={orig_w:.2f}, h={orig_h:.2f}) cm"
                    if elem.content_bbox_debug:
                        detail += f"<br>诊断：{elem.content_bbox_debug}"
                    rows.append([str(idx), md_escape(issue.priority), md_escape(issue.description), md_escape(detail)])

                print_md_table(["序号", "优先级", "问题描述", "详细信息"], rows)

            blank_issues = [issue for issue in slide_issues if issue.issue_type == "blank_slide"]
            if blank_issues:
                print("### 空白页")
                print()
                rows = []
                for idx, issue in enumerate(blank_issues, 1):
                    rows.append([str(idx), md_escape(issue.priority), md_escape(issue.description), ""])
                print_md_table(["序号", "优先级", "问题描述", "详细信息"], rows)
                print()
                print("> ⚠️ Blank slides are generation defects. Each slide must contain at least one visible element. Re-generate content for these slides.")
                print()


def _issue_to_golden_key(issue: LayoutIssue) -> str:
    names = "+".join(e.name for e in issue.elements) if issue.elements else ""
    return f"S{issue.slide_number}|{issue.issue_type}|{issue.priority}|{names}"


def _golden_path_for(pptx_path: str) -> Path:
    return Path(pptx_path).with_suffix(Path(pptx_path).suffix + ".golden.md")


def update_golden(pptx_path: str) -> Path:
    v = PPTXLayoutValidator(pptx_path, verbose=False)
    v.validate()
    report = v.get_report()
    keys = sorted([_issue_to_golden_key(i) for i in v.issues])
    sections = [report.rstrip()]
    if keys:
        sections.append("\n<!-- GOLDEN_KEYS\n" + "\n".join(keys) + "\n-->")
    gp = _golden_path_for(pptx_path)
    gp.write_text("\n".join(sections) + "\n", encoding="utf-8")
    return gp


def regression_check(test_dir: str) -> bool:
    test_path = Path(test_dir)
    pptx_files = sorted(test_path.glob("*.pptx"))
    if not pptx_files:
        print(f"No .pptx files found in {test_dir}")
        return False

    passed = 0
    failed = 0
    skipped = 0

    for pptx_file in pptx_files:
        gp = _golden_path_for(str(pptx_file))
        if not gp.exists():
            print(f"SKIP: {pptx_file.name} (no .golden file)")
            skipped += 1
            continue

        golden_text = gp.read_text(encoding="utf-8")
        golden_key_lines = []
        import re
        m = re.search(r"<!-- GOLDEN_KEYS\n(.*?)\n-->", golden_text, re.DOTALL)
        if m:
            golden_key_lines = sorted([l for l in m.group(1).split("\n") if l.strip()])

        v = PPTXLayoutValidator(str(pptx_file), verbose=False)
        v.validate()
        actual_key_lines = sorted([_issue_to_golden_key(i) for i in v.issues])

        if actual_key_lines == golden_key_lines:
            print(f"PASS: {pptx_file.name} ({len(actual_key_lines)} issues)")
            passed += 1
        else:
            failed += 1
            golden_set = set(golden_key_lines)
            actual_set = set(actual_key_lines)
            added = sorted(actual_set - golden_set)
            removed = sorted(golden_set - actual_set)
            print(f"FAIL: {pptx_file.name} (expected {len(golden_key_lines)}, got {len(actual_key_lines)})")
            for line in added:
                print(f"  + {line}")
            for line in removed:
                print(f"  - {line}")

    total = passed + failed + skipped
    print(f"\nSummary: {passed}/{passed + failed} PASSED"
          + (f", {skipped} SKIPPED" if skipped else "")
          + (f", {failed} FAILED" if failed else ""))
    return failed == 0


def main():
    parser = argparse.ArgumentParser(
        description="Validate PPTX layout for boundary and overlap issues."
    )
    parser.add_argument("pptx_file", nargs="?", help="Input PowerPoint file (.pptx)")
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Show detailed element information"
    )
    parser.add_argument(
        "--slides", "-s",
        type=str,
        default=None,
        help="Comma-separated slide numbers to validate (e.g., 3,5,8). Validates all if not specified."
    )
    parser.add_argument(
        "--update-golden",
        type=str,
        metavar="PATH",
        help="Generate/update .golden file for a .pptx file or all .pptx files in a directory"
    )
    parser.add_argument(
        "--regression",
        type=str,
        metavar="DIR",
        help="Run regression check against .golden files in the given directory"
    )

    args = parser.parse_args()

    if args.update_golden:
        target = Path(args.update_golden)
        if target.is_dir():
            pptx_files = sorted(target.glob("*.pptx"))
            for pf in pptx_files:
                gp = update_golden(str(pf))
                golden_text = gp.read_text(encoding="utf-8")
                m = re.search(r"<!-- GOLDEN_KEYS\n(.*?)\n-->", golden_text, re.DOTALL)
                count = len([l for l in m.group(1).split("\n") if l.strip()]) if m else 0
                print(f"Updated: {pf.name} ({count} issues)")
        elif target.is_file():
            gp = update_golden(str(target))
            golden_text = gp.read_text(encoding="utf-8")
            m = re.search(r"<!-- GOLDEN_KEYS\n(.*?)\n-->", golden_text, re.DOTALL)
            count = len([l for l in m.group(1).split("\n") if l.strip()]) if m else 0
            print(f"Updated: {target.name} ({count} issues)")
        else:
            print(f"Error: {target} not found", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)

    if args.regression:
        success = regression_check(args.regression)
        sys.exit(0 if success else 1)

    if not args.pptx_file:
        parser.error("pptx_file is required when not using --update-golden or --regression")

    slide_filter = None
    if args.slides:
        slide_filter = set()
        for part in args.slides.split(","):
            part = part.strip()
            if part:
                slide_filter.add(int(part))

    validator = PPTXLayoutValidator(args.pptx_file, verbose=args.verbose, slide_filter=slide_filter)
    success = validator.validate()
    validator.print_report()

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
