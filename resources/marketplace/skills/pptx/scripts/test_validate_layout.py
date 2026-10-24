#!/usr/bin/env python3
import io
import math
import os
import sys
import unittest
import zipfile
from pathlib import Path

import defusedxml.minidom
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from validate_layout import (
    BoundingBox,
    SlideElement,
    SlideInfo,
    LayoutIssue,
    PPTXLayoutValidator,
    EMU_PER_CM,
    EMU_PER_POINT,
    _issue_to_golden_key,
    _golden_path_for,
)


def _make_sp_xml(txbody_tag: str, paragraphs_xml: str, off_x=0, off_y=0, cx=3600000, cy=1800000) -> str:
    return (
        f'<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
        f' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        f'<p:nvSpPr><p:cNvPr id="1" name="TextBox 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{off_x}" y="{off_y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        f'<{txbody_tag}>'
        f'<a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr>'
        f'<a:lstStyle/>'
        f'{paragraphs_xml}'
        f'</{txbody_tag}>'
        f'</p:sp>'
    )


def _make_element(x=0, y=0, w=3600000, h=1800000, marL=91440, marR=91440, marT=45720, marB=45720,
                  element_type="text", name="Text Box", has_text=True, is_connector=False,
                  is_decorative=False, content_bbox=None, has_opaque_fill=False,
                  is_label_background=False, is_footer=False, line_width=0,
                  is_line_shape=False, is_arrow=False, arrow_endpoints=None,
                  line_orig_cx=0, line_orig_cy=0, fill_color=None, fill_alpha=1.0,
                  text_color=None, blip_embed_rid="") -> SlideElement:
    return SlideElement(
        element_type=element_type,
        name=name,
        bbox=BoundingBox(x, y, w, h),
        xml_path="ppt/slides/slide1.xml",
        line_number=0,
        is_connector=is_connector,
        has_text=has_text,
        is_decorative=is_decorative,
        marL=marL,
        marR=marR,
        marT=marT,
        marB=marB,
        has_opaque_fill=has_opaque_fill,
        is_label_background=is_label_background,
        is_footer=is_footer,
        line_width=line_width,
        is_line_shape=is_line_shape,
        is_arrow=is_arrow,
        arrow_endpoints=arrow_endpoints,
        line_orig_cx=line_orig_cx,
        line_orig_cy=line_orig_cy,
        content_bbox=content_bbox,
        fill_color=fill_color,
        fill_alpha=fill_alpha,
        text_color=text_color,
        blip_embed_rid=blip_embed_rid,
    )


def _make_slide(width=int(33.87 * EMU_PER_CM), height=int(19.05 * EMU_PER_CM), elements=None) -> SlideInfo:
    return SlideInfo(
        slide_number=1,
        xml_path="ppt/slides/slide1.xml",
        width=width,
        height=height,
        elements=elements or [],
    )


def _make_validator() -> PPTXLayoutValidator:
    return PPTXLayoutValidator()


# ---------------------------------------------------------------------------
# 1. BoundingBox 基础功能
# ---------------------------------------------------------------------------
class TestBoundingBox(unittest.TestCase):

    def test_right_and_bottom(self):
        bb = BoundingBox(100, 200, 300, 400)
        self.assertEqual(bb.right, 400)
        self.assertEqual(bb.bottom, 600)

    def test_to_cm(self):
        bb = BoundingBox(int(1 * EMU_PER_CM), int(2 * EMU_PER_CM),
                         int(3 * EMU_PER_CM), int(4 * EMU_PER_CM))
        x, y, w, h = bb.to_cm()
        self.assertAlmostEqual(x, 1.0, places=2)
        self.assertAlmostEqual(y, 2.0, places=2)
        self.assertAlmostEqual(w, 3.0, places=2)
        self.assertAlmostEqual(h, 4.0, places=2)

    def test_overlaps_true(self):
        a = BoundingBox(0, 0, 100, 100)
        b = BoundingBox(50, 50, 100, 100)
        self.assertTrue(a.overlaps(b))
        self.assertTrue(b.overlaps(a))

    def test_overlaps_false_no_intersection(self):
        a = BoundingBox(0, 0, 100, 100)
        b = BoundingBox(200, 200, 100, 100)
        self.assertFalse(a.overlaps(b))

    def test_overlaps_false_adjacent(self):
        a = BoundingBox(0, 0, 100, 100)
        b = BoundingBox(100, 0, 100, 100)
        self.assertFalse(a.overlaps(b))

    def test_overlaps_contained(self):
        outer = BoundingBox(0, 0, 1000, 1000)
        inner = BoundingBox(100, 100, 200, 200)
        self.assertTrue(outer.overlaps(inner))
        self.assertTrue(inner.overlaps(outer))


# ---------------------------------------------------------------------------
# 2. get_effective_bbox
# ---------------------------------------------------------------------------
class TestGetEffectiveBbox(unittest.TestCase):

    def test_content_bbox_takes_priority(self):
        cb = BoundingBox(10, 20, 30, 40)
        elem = _make_element(content_bbox=cb)
        self.assertEqual(elem.get_effective_bbox(), cb)

    def test_text_with_margins_fallback(self):
        elem = _make_element(x=0, y=0, w=1000, h=800,
                             marL=100, marR=100, marT=50, marB=50)
        eff = elem.get_effective_bbox()
        self.assertEqual(eff.x, 100)
        self.assertEqual(eff.y, 50)
        self.assertEqual(eff.w, 800)
        self.assertEqual(eff.h, 700)

    def test_non_text_returns_original_bbox(self):
        elem = _make_element(element_type="image", name="Picture", has_text=False)
        eff = elem.get_effective_bbox()
        self.assertEqual(eff, elem.bbox)


# ---------------------------------------------------------------------------
# 3. 文本框中正确找到文字
# ---------------------------------------------------------------------------
class TestTextBoxFindText(unittest.TestCase):

    def test_p_txbody_finds_text(self):
        para_xml = (
            '<a:p><a:r><a:rPr lang="zh-CN" sz="1400"/>'
            '<a:t>测试文本内容</a:t></a:r></a:p>'
        )
        sp_xml = _make_sp_xml("p:txBody", para_xml)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement

        v = _make_validator()
        elem = _make_element()
        slide = _make_slide()

        required_bottom, details = v._estimate_textbox_required_bottom_detail(sp_node, elem, slide)

        summary = details[0]
        self.assertNotIn("(no txBody)", summary)
        self.assertIn("len=6", summary)
        self.assertGreater(required_bottom, elem.bbox.y)

    def test_a_txbody_also_works(self):
        para_xml = (
            '<a:p><a:r><a:rPr lang="zh-CN" sz="1400"/>'
            '<a:t>另一段测试</a:t></a:r></a:p>'
        )
        sp_xml = _make_sp_xml("a:txBody", para_xml)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement

        v = _make_validator()
        elem = _make_element()
        slide = _make_slide()

        required_bottom, details = v._estimate_textbox_required_bottom_detail(sp_node, elem, slide)

        summary = details[0]
        self.assertNotIn("(no txBody)", summary)
        self.assertIn("len=5", summary)

    def test_no_txbody_returns_no_txbody(self):
        sp_xml = (
            '<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<p:nvSpPr><p:cNvPr id="1" name="TextBox 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3600000" cy="1800000"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
            '</p:sp>'
        )
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement

        v = _make_validator()
        elem = _make_element()
        slide = _make_slide()

        required_bottom, details = v._estimate_textbox_required_bottom_detail(sp_node, elem, slide)

        self.assertIn("(no txBody)", details[0])


# ---------------------------------------------------------------------------
# 4. 空段落不应该有行数
# ---------------------------------------------------------------------------
class TestEmptyParagraphZeroLines(unittest.TestCase):

    def test_empty_paragraph_contributes_zero_lines(self):
        para_xml = (
            '<a:p><a:r><a:rPr lang="zh-CN" sz="1400"/>'
            '<a:t>有文字</a:t></a:r></a:p>'
            '<a:p><a:endParaRPr lang="zh-CN" sz="1400"/></a:p>'
        )
        sp_xml = _make_sp_xml("p:txBody", para_xml)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement

        v = _make_validator()
        elem = _make_element()
        slide = _make_slide()

        required_bottom, details = v._estimate_textbox_required_bottom_detail(sp_node, elem, slide)

        summary = details[0]
        self.assertIn("lines=1", summary)
        self.assertIn("len=3", summary)

        wrap_detail = details[1] if len(details) > 1 else ""
        self.assertIn("lines=0 p_len=0", wrap_detail)

    def test_only_empty_paragraphs_zero_height(self):
        para_xml = (
            '<a:p><a:endParaRPr lang="zh-CN" sz="1400"/></a:p>'
            '<a:p><a:endParaRPr lang="zh-CN" sz="1400"/></a:p>'
        )
        sp_xml = _make_sp_xml("p:txBody", para_xml)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement

        v = _make_validator()
        elem = _make_element()
        slide = _make_slide()

        required_bottom, details = v._estimate_textbox_required_bottom_detail(sp_node, elem, slide)

        expected_bottom = elem.bbox.y + elem.marT + elem.marB
        self.assertEqual(required_bottom, expected_bottom)

        summary = details[0]
        self.assertIn("lines=0", summary)
        self.assertIn("len=0", summary)


# ---------------------------------------------------------------------------
# 5. 文本框用估算内容高度判断边界
# ---------------------------------------------------------------------------
class TestTextBoxBoundaryEstimation(unittest.TestCase):

    def test_short_text_not_exceeding_boundary(self):
        slide_h = int(19.05 * EMU_PER_CM)
        box_y = int(16.0 * EMU_PER_CM)
        box_h = int(4.0 * EMU_PER_CM)
        box_w = int(17.0 * EMU_PER_CM)

        para_xml = (
            '<a:p><a:r><a:rPr lang="zh-CN" sz="1200"/>'
            '<a:t>短文本</a:t></a:r></a:p>'
        )
        sp_xml = _make_sp_xml("p:txBody", para_xml, off_y=box_y, cx=box_w, cy=box_h)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement

        v = _make_validator()
        elem = _make_element(y=box_y, w=box_w, h=box_h)
        slide = _make_slide(height=slide_h)

        required_bottom, details = v._estimate_textbox_required_bottom_detail(sp_node, elem, slide)

        self.assertGreater(elem.bbox.bottom, slide_h,
                           "框底部应超出页面（测试前提条件）")
        self.assertLessEqual(required_bottom, slide_h,
                             "短文本的内容底部不应超出页面")

    def test_long_text_exceeding_boundary(self):
        slide_h = int(19.05 * EMU_PER_CM)
        box_y = int(17.0 * EMU_PER_CM)
        box_w = int(10.0 * EMU_PER_CM)
        box_h = int(3.0 * EMU_PER_CM)

        long_text = ("案例：2025年7月起，长电在试点楼园实行云电脑租赁市场专用政策。"
                     "7-10月发展租赁市场云电脑681户，其中纯账号308户、利旧终端使用373台，节缩采购成本约42万元。"
                     "通过持续优化政策和扩大试点范围，全年预计完成发展目标。")
        para_xml = (
            '<a:p><a:pPr><a:lnSpc><a:spcPct val="150000"/></a:lnSpc></a:pPr>'
            '<a:r><a:rPr lang="zh-CN" sz="1400">'
            '<a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/>'
            '</a:rPr>'
            f'<a:t>{long_text}</a:t></a:r></a:p>'
        )
        sp_xml = _make_sp_xml("p:txBody", para_xml, off_y=box_y, cx=box_w, cy=box_h)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement

        v = _make_validator()
        elem = _make_element(y=box_y, w=box_w, h=box_h)
        slide = _make_slide(height=slide_h)

        required_bottom, details = v._estimate_textbox_required_bottom_detail(sp_node, elem, slide)

        self.assertGreater(required_bottom, slide_h,
                           "长文本（140%行距、14pt）在y=16.25cm处应超出19.05cm页面")

    def test_content_bottom_used_instead_of_frame_bottom(self):
        slide_h = int(19.05 * EMU_PER_CM)
        box_y = int(16.0 * EMU_PER_CM)
        box_h = int(4.0 * EMU_PER_CM)
        box_w = int(17.0 * EMU_PER_CM)

        para_xml = (
            '<a:p><a:r><a:rPr lang="zh-CN" sz="1200"/>'
            '<a:t>短文本</a:t></a:r></a:p>'
        )
        sp_xml = _make_sp_xml("p:txBody", para_xml, off_y=box_y, cx=box_w, cy=box_h)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement

        v = _make_validator()
        elem = _make_element(y=box_y, w=box_w, h=box_h)
        slide = _make_slide(height=slide_h)

        required_bottom, _ = v._estimate_textbox_required_bottom_detail(sp_node, elem, slide)

        self.assertGreater(elem.bbox.bottom, slide_h)
        self.assertLess(required_bottom, elem.bbox.bottom,
                        "内容底部应小于框底部（短文本不需要整个框高度）")


# ---------------------------------------------------------------------------
# 6. 字符宽度估算
# ---------------------------------------------------------------------------
class TestCharWidthEstimation(unittest.TestCase):

    def test_pure_cjk_wf_is_1(self):
        v = _make_validator()
        avg_w, wf, _ = v._estimate_avg_char_width("测试文本", 14.0, "")
        self.assertAlmostEqual(wf, 1.05, places=2)
        self.assertAlmostEqual(avg_w, 15.288, places=1)

    def test_pure_ascii_letters_wf_less_than_1(self):
        v = _make_validator()
        avg_w, wf, _ = v._estimate_avg_char_width("abcdef", 14.0, "")
        self.assertLess(wf, 0.6)
        self.assertGreater(wf, 0.4)

    def test_mixed_text_wf_between_ascii_and_cjk(self):
        v = _make_validator()
        avg_w, wf, _ = v._estimate_avg_char_width("Hello世界", 14.0, "")
        self.assertGreater(wf, 0.5)
        self.assertLess(wf, 1.0)

    def test_empty_text_returns_default(self):
        v = _make_validator()
        avg_w, wf, _ = v._estimate_avg_char_width("", 14.0, "")
        self.assertAlmostEqual(wf, 1.0, places=2)

    def test_arial_font_adjusts_letter_width(self):
        v = _make_validator()
        _, wf_default, _ = v._estimate_avg_char_width("abc", 14.0, "")
        _, wf_arial, _ = v._estimate_avg_char_width("abc", 14.0, "Arial")
        self.assertLess(wf_arial, wf_default)

    def test_digits_wider_than_letters(self):
        v = _make_validator()
        _, wf_letters, _ = v._estimate_avg_char_width("abcdef", 14.0, "")
        _, wf_digits, _ = v._estimate_avg_char_width("123456", 14.0, "")
        self.assertGreater(wf_digits, wf_letters)


# ---------------------------------------------------------------------------
# 7. _parse_element 解析各类元素
# ---------------------------------------------------------------------------
class TestParseElement(unittest.TestCase):

    def _make_sp_tree_xml(self, children_xml: str) -> str:
        return (
            '<p:spTree xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'{children_xml}'
            '</p:spTree>'
        )

    def _parse_first_child(self, children_xml: str) -> SlideElement:
        xml = self._make_sp_tree_xml(children_xml)
        dom = defusedxml.minidom.parseString(xml)
        sp_tree = dom.getElementsByTagName("p:spTree")[0]
        v = _make_validator()
        for child in sp_tree.childNodes:
            if child.nodeType == child.ELEMENT_NODE:
                return v._parse_element(child, "ppt/slides/slide1.xml")
        return None

    def test_text_box_with_text(self):
        xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:r><a:t>hello</a:t></a:r></a:p></p:txBody>'
            '</p:sp>'
        )
        elem = self._parse_first_child(xml)
        self.assertIsNotNone(elem)
        self.assertEqual(elem.element_type, "text")
        self.assertEqual(elem.name, "Text Box")
        self.assertTrue(elem.has_text)
        self.assertEqual(elem.bbox.x, 100)
        self.assertEqual(elem.bbox.y, 200)

    def test_empty_text_box(self):
        xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:endParaRPr/></a:p></p:txBody>'
            '</p:sp>'
        )
        elem = self._parse_first_child(xml)
        self.assertIsNotNone(elem)
        self.assertEqual(elem.element_type, "text")
        self.assertEqual(elem.name, "Empty Text Box")
        self.assertFalse(elem.has_text)

    def test_shape_no_text(self):
        xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="S1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr>'
            '</p:sp>'
        )
        elem = self._parse_first_child(xml)
        self.assertIsNotNone(elem)
        self.assertEqual(elem.name, "Shape")
        self.assertFalse(elem.has_text)

    def test_picture_element(self):
        xml = (
            '<p:pic>'
            '<p:nvPicPr><p:cNvPr id="1" name="P1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
            '<p:blipFill><a:blip r:embed="rId5"/></p:blipFill>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="500"/></a:xfrm></p:spPr>'
            '</p:pic>'
        )
        elem = self._parse_first_child(xml)
        self.assertIsNotNone(elem)
        self.assertEqual(elem.element_type, "image")
        self.assertEqual(elem.name, "Picture")
        self.assertEqual(elem.blip_embed_rid, "rId5")

    def test_connector_element(self):
        xml = (
            '<p:cxnSp>'
            '<p:nvCxnSpPr><p:cNvPr id="1" name="C1"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>'
            '</p:cxnSp>'
        )
        elem = self._parse_first_child(xml)
        self.assertIsNotNone(elem)
        self.assertEqual(elem.element_type, "connector")
        self.assertEqual(elem.name, "Connector")
        self.assertTrue(elem.is_connector)

    def test_table_element(self):
        xml = (
            '<p:graphicFrame>'
            '<p:nvGraphicFramePr><p:cNvPr id="1" name="T1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
            '<p:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="300"/></p:xfrm>'
            '<a:graphic><a:graphicData><a:tbl>'
            '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr>'
            '</a:tbl></a:graphicData></a:graphic>'
            '</p:graphicFrame>'
        )
        elem = self._parse_first_child(xml)
        self.assertIsNotNone(elem)
        self.assertEqual(elem.element_type, "table")
        self.assertEqual(elem.name, "Table")
        self.assertTrue(elem.has_text)

    def test_group_shape_returns_none(self):
        xml = (
            '<p:grpSp>'
            '<p:nvGrpSpPr><p:cNvPr id="1" name="G1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:grpSpPr>'
            '</p:grpSp>'
        )
        elem = self._parse_first_child(xml)
        self.assertIsNone(elem)

    def test_bodypr_margins_parsed(self):
        xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr lIns="50000" rIns="60000" tIns="30000" bIns="40000"/>'
            '<a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody>'
            '</p:sp>'
        )
        elem = self._parse_first_child(xml)
        self.assertEqual(elem.marL, 50000)
        self.assertEqual(elem.marR, 60000)
        self.assertEqual(elem.marT, 30000)
        self.assertEqual(elem.marB, 40000)

    def test_bodypr_default_margins(self):
        xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody>'
            '</p:sp>'
        )
        elem = self._parse_first_child(xml)
        self.assertEqual(elem.marL, 91440)
        self.assertEqual(elem.marR, 91440)
        self.assertEqual(elem.marT, 45720)
        self.assertEqual(elem.marB, 45720)


# ---------------------------------------------------------------------------
# 8. Decorative 元素标记
# ---------------------------------------------------------------------------
class TestDecorativeElements(unittest.TestCase):

    def _build_sp_tree_dom(self, children_xml: str):
        xml = (
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<p:cSld><p:spTree>'
            f'{children_xml}'
            '</p:spTree></p:cSld>'
            '</p:sld>'
        )
        return defusedxml.minidom.parseString(xml)

    def test_shape_without_text_is_decorative(self):
        child_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="S1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="500"/></a:xfrm></p:spPr>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(child_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 1)
        self.assertTrue(elements[0].is_decorative)

    def test_empty_text_box_is_decorative(self):
        child_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="500"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:endParaRPr/></a:p></p:txBody>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(child_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 1)
        self.assertTrue(elements[0].is_decorative)

    def test_text_box_with_text_not_decorative(self):
        child_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3600000" cy="1800000"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:r><a:t>hello</a:t></a:r></a:p></p:txBody>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(child_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 1)
        self.assertFalse(elements[0].is_decorative)

    def test_connector_not_decorative(self):
        child_xml = (
            '<p:cxnSp>'
            '<p:nvCxnSpPr><p:cNvPr id="1" name="C1"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>'
            '</p:cxnSp>'
        )
        dom = self._build_sp_tree_dom(child_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 1)
        self.assertFalse(elements[0].is_decorative)


# ---------------------------------------------------------------------------
# 9. 重叠检测逻辑
# ---------------------------------------------------------------------------
class TestOverlapDetection(unittest.TestCase):

    def test_connector_to_connector_ignored(self):
        e1 = _make_element(x=0, y=0, w=1000, h=1000, element_type="connector",
                           name="Connector", is_connector=True, has_text=False)
        e2 = _make_element(x=500, y=500, w=1000, h=1000, element_type="connector",
                           name="Connector", is_connector=True, has_text=False)
        slide = _make_slide(elements=[e1, e2])
        v = _make_validator()
        v.slides = [slide]
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 0)

    def test_decorative_element_ignored(self):
        e1 = _make_element(x=0, y=0, w=1000, h=1000, element_type="shape",
                           name="Shape", has_text=False, is_decorative=True)
        e2 = _make_element(x=500, y=500, w=1000, h=1000)
        slide = _make_slide(elements=[e1, e2])
        v = _make_validator()
        v.slides = [slide]
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 0)

    def test_overlap_below_5_percent_not_reported(self):
        e1 = _make_element(x=0, y=0, w=10000, h=10000)
        e2 = _make_element(x=9800, y=9800, w=10000, h=10000)
        slide = _make_slide(elements=[e1, e2])
        v = _make_validator()
        v.slides = [slide]
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 0)

    def test_significant_overlap_reported(self):
        sz = int(1 * EMU_PER_CM)
        e1 = _make_element(x=0, y=0, w=sz, h=sz,
                           content_bbox=BoundingBox(0, 0, sz, sz))
        e2 = _make_element(x=0, y=0, w=sz, h=sz,
                           content_bbox=BoundingBox(0, 0, sz, sz))
        slide = _make_slide(elements=[e1, e2])
        v = _make_validator()
        v.slides = [slide]
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 1)
        self.assertEqual(v.issues[0].issue_type, "overlap")
        self.assertEqual(v.issues[0].priority, "P0")


# ---------------------------------------------------------------------------
# 10. 边界检查逻辑
# ---------------------------------------------------------------------------
class TestBoundaryCheck(unittest.TestCase):

    def test_element_inside_slide_no_issue(self):
        slide_w = int(10 * EMU_PER_CM)
        slide_h = int(10 * EMU_PER_CM)
        e = _make_element(x=int(1 * EMU_PER_CM), y=int(1 * EMU_PER_CM),
                          w=int(2 * EMU_PER_CM), h=int(2 * EMU_PER_CM),
                          element_type="shape", name="Shape", has_text=False)
        slide = _make_slide(width=slide_w, height=slide_h, elements=[e])
        v = _make_validator()
        v.slides = [slide]
        v._check_slide_boundaries(slide)
        self.assertEqual(len(v.issues), 0)

    def test_element_exceeding_right_boundary(self):
        slide_w = int(10 * EMU_PER_CM)
        slide_h = int(10 * EMU_PER_CM)
        e = _make_element(x=int(9 * EMU_PER_CM), y=0,
                          w=int(3 * EMU_PER_CM), h=int(1 * EMU_PER_CM),
                          element_type="shape", name="Shape", has_text=False)
        slide = _make_slide(width=slide_w, height=slide_h, elements=[e])
        v = _make_validator()
        v.slides = [slide]
        v._check_slide_boundaries(slide)
        self.assertEqual(len(v.issues), 1)
        self.assertEqual(v.issues[0].issue_type, "boundary")

    def test_element_exceeding_bottom_boundary(self):
        slide_w = int(10 * EMU_PER_CM)
        slide_h = int(10 * EMU_PER_CM)
        e = _make_element(x=0, y=int(9 * EMU_PER_CM),
                          w=int(1 * EMU_PER_CM), h=int(3 * EMU_PER_CM),
                          element_type="shape", name="Shape", has_text=False)
        slide = _make_slide(width=slide_w, height=slide_h, elements=[e])
        v = _make_validator()
        v.slides = [slide]
        v._check_slide_boundaries(slide)
        self.assertEqual(len(v.issues), 1)

    def test_empty_text_box_skipped(self):
        slide_w = int(10 * EMU_PER_CM)
        slide_h = int(10 * EMU_PER_CM)
        e = _make_element(x=int(9 * EMU_PER_CM), y=0,
                          w=int(3 * EMU_PER_CM), h=int(1 * EMU_PER_CM),
                          element_type="text", name="Empty Text Box", has_text=False)
        slide = _make_slide(width=slide_w, height=slide_h, elements=[e])
        v = _make_validator()
        v.slides = [slide]
        v._check_slide_boundaries(slide)
        self.assertEqual(len(v.issues), 0)


# ---------------------------------------------------------------------------
# 11. content_bbox 对齐方式
# ---------------------------------------------------------------------------
class TestContentBboxAlignment(unittest.TestCase):

    def _compute_bbox(self, algn: str, text: str, box_w=int(10 * EMU_PER_CM)):
        para_xml = (
            f'<a:p><a:pPr algn="{algn}"/>'
            f'<a:r><a:rPr lang="zh-CN" sz="1400"/>'
            f'<a:t>{text}</a:t></a:r></a:p>'
        )
        sp_xml = _make_sp_xml("p:txBody", para_xml, cx=box_w)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement

        v = _make_validator()
        elem = _make_element(w=box_w)
        cb, _, _, debug, _ = v._compute_text_content_bbox(sp_node, elem)
        return cb, debug

    def test_left_align_starts_at_margin(self):
        cb, _ = self._compute_bbox("l", "测试")
        self.assertIsNotNone(cb)
        self.assertEqual(cb.x, 91440)

    def test_center_align_centered(self):
        box_w = int(10 * EMU_PER_CM)
        cb, _ = self._compute_bbox("ctr", "测试")
        self.assertIsNotNone(cb)
        expected_center = box_w // 2
        actual_center = cb.x + cb.w // 2
        self.assertAlmostEqual(actual_center / EMU_PER_CM, expected_center / EMU_PER_CM, places=0)

    def test_right_align_ends_at_right_margin(self):
        box_w = int(10 * EMU_PER_CM)
        cb, _ = self._compute_bbox("r", "测试")
        self.assertIsNotNone(cb)
        expected_right = box_w - 91440
        self.assertAlmostEqual(cb.right / EMU_PER_CM, expected_right / EMU_PER_CM, places=0)


# ---------------------------------------------------------------------------
# 12. 构造函数测试
# ---------------------------------------------------------------------------
class TestValidatorInit(unittest.TestCase):

    def test_no_args_creates_empty_instance(self):
        v = PPTXLayoutValidator()
        self.assertIsNone(v.pptx_path)
        self.assertEqual(v.slides, [])
        self.assertEqual(v.issues, [])

    def test_with_path_sets_path(self):
        v = PPTXLayoutValidator("/tmp/test.pptx")
        self.assertIsNotNone(v.pptx_path)


# ---------------------------------------------------------------------------
# 13. 段落文本分段（含 <a:br> 换行）
# ---------------------------------------------------------------------------
class TestExtractParagraphTextSegments(unittest.TestCase):

    def _parse_p(self, p_inner_xml: str):
        xml = (
            '<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            f'{p_inner_xml}'
            '</a:p>'
        )
        return defusedxml.minidom.parseString(xml).documentElement

    def test_single_run(self):
        p = self._parse_p('<a:r><a:t>Hello</a:t></a:r>')
        v = _make_validator()
        segs = v._extract_paragraph_text_segments(p)
        self.assertEqual(segs, ["Hello"])

    def test_multiple_runs_concatenated(self):
        p = self._parse_p('<a:r><a:t>Hello</a:t></a:r><a:r><a:t> World</a:t></a:r>')
        v = _make_validator()
        segs = v._extract_paragraph_text_segments(p)
        self.assertEqual(segs, ["Hello World"])

    def test_br_creates_new_segment(self):
        p = self._parse_p('<a:r><a:t>Line1</a:t></a:r><a:br/><a:r><a:t>Line2</a:t></a:r>')
        v = _make_validator()
        segs = v._extract_paragraph_text_segments(p)
        self.assertEqual(len(segs), 2)
        self.assertEqual(segs[0], "Line1")
        self.assertEqual(segs[1], "Line2")

    def test_empty_paragraph(self):
        p = self._parse_p('<a:endParaRPr/>')
        v = _make_validator()
        segs = v._extract_paragraph_text_segments(p)
        self.assertEqual(segs, [""])


# ---------------------------------------------------------------------------
# 14. 行高估算
# ---------------------------------------------------------------------------
class TestEstimateParagraphLineHeight(unittest.TestCase):

    def _parse_p(self, p_inner_xml: str):
        xml = (
            '<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            f'{p_inner_xml}'
            '</a:p>'
        )
        return defusedxml.minidom.parseString(xml).documentElement

    def test_default_line_height_120_percent_latin(self):
        p = self._parse_p('<a:r><a:t>text</a:t></a:r>')
        v = _make_validator()
        lh = v._estimate_paragraph_line_height_pt(p, 14.0)
        self.assertAlmostEqual(lh, 14.0 * 1.2, places=1)

    def test_default_line_height_130_percent_cjk(self):
        p = self._parse_p('<a:r><a:t>\u4e2d\u6587\u6d4b\u8bd5</a:t></a:r>')
        v = _make_validator()
        lh = v._estimate_paragraph_line_height_pt(p, 14.0)
        self.assertAlmostEqual(lh, 14.0 * 1.25, places=1)

    def test_spc_pct_150_percent(self):
        p = self._parse_p(
            '<a:pPr><a:lnSpc><a:spcPct val="150000"/></a:lnSpc></a:pPr>'
            '<a:r><a:t>text</a:t></a:r>'
        )
        v = _make_validator()
        lh = v._estimate_paragraph_line_height_pt(p, 14.0)
        self.assertAlmostEqual(lh, 14.0 * 1.2 * 1.5, places=1)

    def test_spc_pts_fixed(self):
        p = self._parse_p(
            '<a:pPr><a:lnSpc><a:spcPts val="2000"/></a:lnSpc></a:pPr>'
            '<a:r><a:t>text</a:t></a:r>'
        )
        v = _make_validator()
        lh = v._estimate_paragraph_line_height_pt(p, 14.0)
        self.assertAlmostEqual(lh, 20.0, places=1)


# ---------------------------------------------------------------------------
# 15. 字符分类方法
# ---------------------------------------------------------------------------
class TestCharClassification(unittest.TestCase):

    def test_cjk_chars(self):
        v = _make_validator()
        self.assertTrue(v._is_cjk_char("中"))
        self.assertTrue(v._is_cjk_char("世"))
        self.assertFalse(v._is_cjk_char("A"))
        self.assertFalse(v._is_cjk_char("1"))
        self.assertFalse(v._is_cjk_char(""))

    def test_fullwidth_punctuation(self):
        v = _make_validator()
        self.assertTrue(v._is_fullwidth_punctuation("、"))
        self.assertTrue(v._is_fullwidth_punctuation("。"))
        self.assertTrue(v._is_fullwidth_punctuation("！"))
        self.assertFalse(v._is_fullwidth_punctuation(","))
        self.assertFalse(v._is_fullwidth_punctuation(""))

    def test_general_punctuation(self):
        v = _make_validator()
        self.assertTrue(v._is_general_punctuation("\u2014"))
        self.assertTrue(v._is_general_punctuation("\u2026"))
        self.assertFalse(v._is_general_punctuation("A"))
        self.assertFalse(v._is_general_punctuation(""))


# ---------------------------------------------------------------------------
# 16. _get_node_bbox
# ---------------------------------------------------------------------------
class TestGetNodeBbox(unittest.TestCase):

    def test_valid_xfrm(self):
        xml = (
            '<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr>'
            '</p:sp>'
        )
        node = defusedxml.minidom.parseString(xml).documentElement
        v = _make_validator()
        bb = v._get_node_bbox(node)
        self.assertIsNotNone(bb)
        self.assertEqual(bb.x, 100)
        self.assertEqual(bb.y, 200)
        self.assertEqual(bb.w, 300)
        self.assertEqual(bb.h, 400)

    def test_p_xfrm_fallback(self):
        xml = (
            '<p:graphicFrame xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<p:xfrm><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></p:xfrm>'
            '</p:graphicFrame>'
        )
        node = defusedxml.minidom.parseString(xml).documentElement
        v = _make_validator()
        bb = v._get_node_bbox(node)
        self.assertIsNotNone(bb)
        self.assertEqual(bb.x, 10)

    def test_no_xfrm_returns_none(self):
        xml = (
            '<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<p:spPr/>'
            '</p:sp>'
        )
        node = defusedxml.minidom.parseString(xml).documentElement
        v = _make_validator()
        bb = v._get_node_bbox(node)
        self.assertIsNone(bb)

    def test_zero_size_returns_none(self):
        xml = (
            '<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="100"/></a:xfrm></p:spPr>'
            '</p:sp>'
        )
        node = defusedxml.minidom.parseString(xml).documentElement
        v = _make_validator()
        bb = v._get_node_bbox(node)
        self.assertIsNone(bb)


# ---------------------------------------------------------------------------
# 17. _extract_elements 中 table 文本提取
# ---------------------------------------------------------------------------
class TestExtractElementsTableText(unittest.TestCase):

    def _build_slide_dom(self, sp_tree_children: str):
        xml = (
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<p:cSld><p:spTree>'
            f'{sp_tree_children}'
            '</p:spTree></p:cSld>'
            '</p:sld>'
        )
        return defusedxml.minidom.parseString(xml)

    def test_table_text_extracted_in_debug(self):
        child_xml = (
            '<p:graphicFrame>'
            '<p:nvGraphicFramePr><p:cNvPr id="1" name="T1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
            '<p:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="300"/></p:xfrm>'
            '<a:graphic><a:graphicData><a:tbl>'
            '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Hello</a:t></a:r></a:p></a:txBody></a:tc></a:tr>'
            '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>World</a:t></a:r></a:p></a:txBody></a:tc></a:tr>'
            '</a:tbl></a:graphicData></a:graphic>'
            '</p:graphicFrame>'
        )
        dom = self._build_slide_dom(child_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 1)
        self.assertIn('text="HelloWorld"', elements[0].content_bbox_debug)

    def test_table_text_truncated_at_50(self):
        long_text = "A" * 60
        child_xml = (
            '<p:graphicFrame>'
            '<p:nvGraphicFramePr><p:cNvPr id="1" name="T1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
            '<p:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="300"/></p:xfrm>'
            '<a:graphic><a:graphicData><a:tbl>'
            f'<a:tr><a:tc><a:txBody><a:p><a:r><a:t>{long_text}</a:t></a:r></a:p></a:txBody></a:tc></a:tr>'
            '</a:tbl></a:graphicData></a:graphic>'
            '</p:graphicFrame>'
        )
        dom = self._build_slide_dom(child_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 1)
        self.assertIn("...", elements[0].content_bbox_debug)
        text_part = elements[0].content_bbox_debug.split('"')[1]
        self.assertLessEqual(len(text_part), 50)


# ---------------------------------------------------------------------------
# 18. _image_has_alpha（使用内存中的 ZIP 模拟）
# ---------------------------------------------------------------------------
class TestImageHasAlpha(unittest.TestCase):

    def _make_png_bytes(self, mode: str) -> bytes:
        img = Image.new(mode, (10, 10), (255, 0, 0, 128) if "A" in mode else (255, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def _make_zip_with_image(self, img_bytes: bytes) -> zipfile.ZipFile:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("ppt/slides/_rels/slide1.xml.rels",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Target="../media/image1.png" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>'
                '</Relationships>'
            )
            zf.writestr("ppt/media/image1.png", img_bytes)
        buf.seek(0)
        return zipfile.ZipFile(buf, "r")

    def test_rgba_image_detected(self):
        zf = self._make_zip_with_image(self._make_png_bytes("RGBA"))
        v = _make_validator()
        self.assertTrue(v._image_has_alpha(zf, "ppt/slides/slide1.xml", "rId1"))
        zf.close()

    def test_rgb_image_not_alpha(self):
        zf = self._make_zip_with_image(self._make_png_bytes("RGB"))
        v = _make_validator()
        self.assertFalse(v._image_has_alpha(zf, "ppt/slides/slide1.xml", "rId1"))
        zf.close()

    def test_missing_rels_returns_false(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("ppt/slides/slide1.xml", "<root/>")
        buf.seek(0)
        zf = zipfile.ZipFile(buf, "r")
        v = _make_validator()
        self.assertFalse(v._image_has_alpha(zf, "ppt/slides/slide1.xml", "rId1"))
        zf.close()

    def test_missing_rid_returns_false(self):
        zf = self._make_zip_with_image(self._make_png_bytes("RGB"))
        v = _make_validator()
        self.assertFalse(v._image_has_alpha(zf, "ppt/slides/slide1.xml", "rId999"))
        zf.close()


# ---------------------------------------------------------------------------
# 19. _overlap_region_is_transparent (图片重叠区域透明度检测)
# ---------------------------------------------------------------------------
class TestOverlapRegionTransparency(unittest.TestCase):

    def _make_pptx_with_image(self, img_bytes: bytes) -> str:
        import tempfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("ppt/slides/_rels/slide1.xml.rels",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Target="../media/image1.png" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>'
                '</Relationships>'
            )
            zf.writestr("ppt/media/image1.png", img_bytes)
        tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
        tmp.write(buf.getvalue())
        tmp.close()
        return tmp.name

    def _make_opaque_png(self) -> bytes:
        img = Image.new("RGBA", (100, 100), (255, 0, 0, 255))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def _make_transparent_png(self) -> bytes:
        img = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def _make_partial_png(self, opaque_fraction: float) -> bytes:
        img = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
        opaque_rows = int(100 * opaque_fraction)
        for y in range(opaque_rows):
            for x in range(100):
                img.putpixel((x, y), (255, 0, 0, 255))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def test_fully_opaque_overlap_not_transparent(self):
        path = self._make_pptx_with_image(self._make_opaque_png())
        try:
            v = PPTXLayoutValidator(path)
            img_elem = _make_element(x=0, y=0, w=3600000, h=3600000, element_type="image", name="Picture")
            img_elem.blip_embed_rid = "rId1"
            other_elem = _make_element(x=0, y=0, w=1800000, h=1800000, element_type="text", name="Text Box")
            slide = _make_slide(elements=[img_elem, other_elem])
            slide.xml_path = "ppt/slides/slide1.xml"
            self.assertFalse(v._overlap_region_is_transparent(img_elem, other_elem, slide.xml_path))
        finally:
            os.unlink(path)

    def test_fully_transparent_overlap_is_transparent(self):
        path = self._make_pptx_with_image(self._make_transparent_png())
        try:
            v = PPTXLayoutValidator(path)
            img_elem = _make_element(x=0, y=0, w=3600000, h=3600000, element_type="image", name="Picture")
            img_elem.blip_embed_rid = "rId1"
            other_elem = _make_element(x=0, y=0, w=1800000, h=1800000, element_type="text", name="Text Box")
            slide = _make_slide(elements=[img_elem, other_elem])
            slide.xml_path = "ppt/slides/slide1.xml"
            self.assertTrue(v._overlap_region_is_transparent(img_elem, other_elem, slide.xml_path))
        finally:
            os.unlink(path)

    def test_below_2pct_opaque_is_transparent(self):
        path = self._make_pptx_with_image(self._make_partial_png(0.01))
        try:
            v = PPTXLayoutValidator(path)
            img_elem = _make_element(x=0, y=0, w=3600000, h=3600000, element_type="image", name="Picture")
            img_elem.blip_embed_rid = "rId1"
            other_elem = _make_element(x=0, y=0, w=3600000, h=3600000, element_type="text", name="Text Box")
            slide = _make_slide(elements=[img_elem, other_elem])
            slide.xml_path = "ppt/slides/slide1.xml"
            self.assertTrue(v._overlap_region_is_transparent(img_elem, other_elem, slide.xml_path))
        finally:
            os.unlink(path)

    def test_above_2pct_opaque_not_transparent(self):
        path = self._make_pptx_with_image(self._make_partial_png(0.05))
        try:
            v = PPTXLayoutValidator(path)
            img_elem = _make_element(x=0, y=0, w=3600000, h=3600000, element_type="image", name="Picture")
            img_elem.blip_embed_rid = "rId1"
            other_elem = _make_element(x=0, y=0, w=3600000, h=3600000, element_type="text", name="Text Box")
            slide = _make_slide(elements=[img_elem, other_elem])
            slide.xml_path = "ppt/slides/slide1.xml"
            self.assertFalse(v._overlap_region_is_transparent(img_elem, other_elem, slide.xml_path))
        finally:
            os.unlink(path)

    def test_rgb_image_not_transparent(self):
        img = Image.new("RGB", (100, 100), (255, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        path = self._make_pptx_with_image(buf.getvalue())
        try:
            v = PPTXLayoutValidator(path)
            img_elem = _make_element(x=0, y=0, w=3600000, h=3600000, element_type="image", name="Picture")
            img_elem.blip_embed_rid = "rId1"
            other_elem = _make_element(x=0, y=0, w=1800000, h=1800000, element_type="text", name="Text Box")
            slide = _make_slide(elements=[img_elem, other_elem])
            slide.xml_path = "ppt/slides/slide1.xml"
            self.assertFalse(v._overlap_region_is_transparent(img_elem, other_elem, slide.xml_path))
        finally:
            os.unlink(path)

    def test_no_bbox_overlap_returns_false(self):
        path = self._make_pptx_with_image(self._make_transparent_png())
        try:
            v = PPTXLayoutValidator(path)
            img_elem = _make_element(x=0, y=0, w=1000, h=1000, element_type="image", name="Picture")
            img_elem.blip_embed_rid = "rId1"
            other_elem = _make_element(x=9999000, y=9999000, w=1000, h=1000, element_type="text", name="Text Box")
            slide = _make_slide(elements=[img_elem, other_elem])
            slide.xml_path = "ppt/slides/slide1.xml"
            self.assertFalse(v._overlap_region_is_transparent(img_elem, other_elem, slide.xml_path))
        finally:
            os.unlink(path)

    def test_no_pptx_path_returns_false(self):
        v = PPTXLayoutValidator()
        img_elem = _make_element(x=0, y=0, w=1000, h=1000, element_type="image", name="Picture")
        img_elem.blip_embed_rid = "rId1"
        other_elem = _make_element(x=0, y=0, w=1000, h=1000, element_type="text", name="Text Box")
        self.assertFalse(v._overlap_region_is_transparent(img_elem, other_elem, "ppt/slides/slide1.xml"))


# ---------------------------------------------------------------------------
# 20. _compute_text_content_bbox 详细行为
# ---------------------------------------------------------------------------
class TestComputeTextContentBbox(unittest.TestCase):

    def _make_sp_and_elem(self, para_xml: str, box_w=int(10 * EMU_PER_CM)):
        sp_xml = _make_sp_xml("p:txBody", para_xml, cx=box_w)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement
        elem = _make_element(w=box_w)
        return sp_node, elem

    def test_no_txbody_returns_none(self):
        xml = (
            '<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3600000" cy="1800000"/></a:xfrm></p:spPr>'
            '</p:sp>'
        )
        sp_node = defusedxml.minidom.parseString(xml).documentElement
        elem = _make_element()
        v = _make_validator()
        cb, _, _, debug, _ = v._compute_text_content_bbox(sp_node, elem)
        self.assertIsNone(cb)
        self.assertIn("no txBody", debug)

    def test_empty_text_returns_single_line(self):
        para_xml = '<a:p><a:endParaRPr lang="zh-CN" sz="1400"/></a:p>'
        sp_node, elem = self._make_sp_and_elem(para_xml)
        v = _make_validator()
        cb, _, _, debug, _ = v._compute_text_content_bbox(sp_node, elem)
        self.assertIsNotNone(cb)

    def test_text_content_in_debug(self):
        para_xml = '<a:p><a:r><a:rPr lang="zh-CN" sz="1400"/><a:t>测试文本</a:t></a:r></a:p>'
        sp_node, elem = self._make_sp_and_elem(para_xml)
        v = _make_validator()
        cb, _, _, debug, _ = v._compute_text_content_bbox(sp_node, elem)
        self.assertIsNotNone(cb)
        self.assertIn('text="测试文本"', debug)

    def test_long_text_truncated_in_debug(self):
        long_text = "这是一段非常长的测试文本" * 10
        para_xml = f'<a:p><a:r><a:rPr lang="zh-CN" sz="1400"/><a:t>{long_text}</a:t></a:r></a:p>'
        sp_node, elem = self._make_sp_and_elem(para_xml)
        v = _make_validator()
        cb, _, _, debug, _ = v._compute_text_content_bbox(sp_node, elem)
        self.assertIn("...", debug)


# ---------------------------------------------------------------------------
# 20. _get_attr_int 工具方法
# ---------------------------------------------------------------------------
class TestGetAttrInt(unittest.TestCase):

    def _make_node(self, xml: str):
        return defusedxml.minidom.parseString(xml).documentElement

    def test_existing_attr(self):
        node = self._make_node('<a x="42"/>')
        v = _make_validator()
        self.assertEqual(v._get_attr_int(node, "x", 0), 42)

    def test_missing_attr_returns_default(self):
        node = self._make_node('<a/>')
        v = _make_validator()
        self.assertEqual(v._get_attr_int(node, "x", 99), 99)

    def test_none_node_returns_default(self):
        v = _make_validator()
        self.assertEqual(v._get_attr_int(None, "x", 77), 77)

    def test_non_int_attr_returns_default(self):
        node = self._make_node('<a x="abc"/>')
        v = _make_validator()
        self.assertEqual(v._get_attr_int(node, "x", 0), 0)


# ---------------------------------------------------------------------------
# 21. 重叠检测中 content_bbox_debug 包含诊断信息
# ---------------------------------------------------------------------------
class TestOverlapDiagnosticInfo(unittest.TestCase):

    def test_overlap_issue_contains_elements_with_debug(self):
        sz = int(1 * EMU_PER_CM)
        cb1 = BoundingBox(0, 0, sz, sz)
        cb2 = BoundingBox(0, 0, sz, sz)
        e1 = _make_element(x=0, y=0, w=2 * sz, h=2 * sz, content_bbox=cb1)
        e1.content_bbox_debug = 'text="Hello"'
        e2 = _make_element(x=0, y=0, w=2 * sz, h=2 * sz, content_bbox=cb2)
        e2.content_bbox_debug = 'text="World"'
        slide = _make_slide(elements=[e1, e2])
        v = _make_validator()
        v.slides = [slide]
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 1)
        issue = v.issues[0]
        self.assertEqual(len(issue.elements), 2)
        self.assertEqual(issue.elements[0].content_bbox_debug, 'text="Hello"')
        self.assertEqual(issue.elements[1].content_bbox_debug, 'text="World"')


# ---------------------------------------------------------------------------
# 22. _estimate_cell_required_height_emu 单元格高度
# ---------------------------------------------------------------------------
class TestEstimateCellHeight(unittest.TestCase):

    def _make_tc(self, text: str, sz: int = 1400) -> object:
        xml = (
            '<a:tc xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<a:txBody><a:bodyPr/>'
            f'<a:p><a:r><a:rPr lang="zh-CN" sz="{sz}"/><a:t>{text}</a:t></a:r></a:p>'
            '</a:txBody>'
            '</a:tc>'
        )
        return defusedxml.minidom.parseString(xml).documentElement

    def test_short_text_cell(self):
        tc = self._make_tc("短文本")
        v = _make_validator()
        h = v._estimate_cell_required_height_emu(tc, int(5 * EMU_PER_CM))
        self.assertGreater(h, 0)

    def test_long_text_needs_more_height(self):
        tc_short = self._make_tc("短")
        tc_long = self._make_tc("这是一段非常长的文本需要换行才能显示完全在单元格中体现出来的高度差异")
        v = _make_validator()
        h_short = v._estimate_cell_required_height_emu(tc_short, int(3 * EMU_PER_CM))
        h_long = v._estimate_cell_required_height_emu(tc_long, int(3 * EMU_PER_CM))
        self.assertGreater(h_long, h_short)

    def test_empty_tc_returns_margins_only(self):
        xml = (
            '<a:tc xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<a:txBody><a:bodyPr/>'
            '<a:p><a:endParaRPr lang="zh-CN" sz="1400"/></a:p>'
            '</a:txBody>'
            '</a:tc>'
        )
        tc = defusedxml.minidom.parseString(xml).documentElement
        v = _make_validator()
        h = v._estimate_cell_required_height_emu(tc, int(5 * EMU_PER_CM))
        self.assertGreater(h, 0)


# ---------------------------------------------------------------------------
# 23. _find_element_by_bbox
# ---------------------------------------------------------------------------
class TestFindElementByBbox(unittest.TestCase):

    def test_finds_matching_element(self):
        e = _make_element(x=100, y=200, w=300, h=400, element_type="table", name="Table")
        slide = _make_slide(elements=[e])
        v = _make_validator()
        result = v._find_element_by_bbox(slide, "table", BoundingBox(100, 200, 300, 400))
        self.assertIsNotNone(result)
        self.assertEqual(result.name, "Table")

    def test_returns_none_for_wrong_type(self):
        e = _make_element(x=100, y=200, w=300, h=400, element_type="text", name="Text Box")
        slide = _make_slide(elements=[e])
        v = _make_validator()
        result = v._find_element_by_bbox(slide, "table", BoundingBox(100, 200, 300, 400))
        self.assertIsNone(result)

    def test_returns_none_for_wrong_bbox(self):
        e = _make_element(x=100, y=200, w=300, h=400, element_type="table", name="Table")
        slide = _make_slide(elements=[e])
        v = _make_validator()
        result = v._find_element_by_bbox(slide, "table", BoundingBox(999, 999, 300, 400))
        self.assertIsNone(result)


# ---------------------------------------------------------------------------
# 24. 边界检查中 text box 使用内容底部而非框底部
# ---------------------------------------------------------------------------
class TestBoundaryCheckUsesContentBottom(unittest.TestCase):

    def test_textbox_with_short_text_no_issue_even_if_frame_exceeds(self):
        slide_h = int(19.05 * EMU_PER_CM)
        box_y = int(16.0 * EMU_PER_CM)
        box_w = int(17.0 * EMU_PER_CM)
        box_h = int(4.0 * EMU_PER_CM)

        sp_xml = (
            '<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<p:nvSpPr><p:cNvPr id="1" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="0" y="{box_y}"/><a:ext cx="{box_w}" cy="{box_h}"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>'
            '<a:p><a:r><a:rPr lang="zh-CN" sz="1200"/><a:t>短文本</a:t></a:r></a:p>'
            '</p:txBody>'
            '</p:sp>'
        )

        slide_xml = (
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            f'<p:cSld><p:spTree>{sp_xml}</p:spTree></p:cSld>'
            '</p:sld>'
        )
        dom = defusedxml.minidom.parseString(slide_xml)

        elem = _make_element(x=0, y=box_y, w=box_w, h=box_h, element_type="text",
                             name="Text Box", has_text=True,
                             marL=91440, marR=91440, marT=45720, marB=45720)
        slide = _make_slide(height=slide_h, elements=[elem])
        slide.xml_path = "ppt/slides/slide1.xml"

        v = _make_validator()
        v._slide_doms["ppt/slides/slide1.xml"] = dom
        v.slides = [slide]

        self.assertGreater(elem.bbox.bottom, slide_h)

        v._check_slide_boundaries(slide)
        boundary_issues = [i for i in v.issues if i.issue_type == "boundary"]
        self.assertEqual(len(boundary_issues), 0,
                         "短文本的内容底部未超出页面，不应报告边界问题")


# ---------------------------------------------------------------------------
# 25. anchor 垂直对齐（_compute_text_content_bbox 中 anchor="ctr"/"b"/"t"）
# ---------------------------------------------------------------------------
class TestAnchorVerticalAlignment(unittest.TestCase):

    def _make_sp_xml_with_anchor(self, anchor: str, para_xml: str,
                                  box_w=int(10 * EMU_PER_CM), box_h=int(5 * EMU_PER_CM)):
        body_pr_attrs = f'wrap="square" rtlCol="0"'
        if anchor:
            body_pr_attrs += f' anchor="{anchor}"'
        return (
            f'<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            f' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            f'<p:nvSpPr><p:cNvPr id="1" name="TextBox 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{box_w}" cy="{box_h}"/></a:xfrm>'
            f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
            f'<p:txBody>'
            f'<a:bodyPr {body_pr_attrs}><a:spAutoFit/></a:bodyPr>'
            f'<a:lstStyle/>'
            f'{para_xml}'
            f'</p:txBody>'
            f'</p:sp>'
        )

    def _compute(self, anchor: str, box_h=int(5 * EMU_PER_CM)):
        para_xml = '<a:p><a:r><a:rPr lang="zh-CN" sz="1400"/><a:t>Test</a:t></a:r></a:p>'
        sp_xml = self._make_sp_xml_with_anchor(anchor, para_xml, box_h=box_h)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement
        elem = _make_element(w=int(10 * EMU_PER_CM), h=box_h)
        v = _make_validator()
        cb, _, _, debug, _ = v._compute_text_content_bbox(sp_node, elem)
        return cb

    def test_top_anchor_content_at_top(self):
        cb = self._compute("t")
        self.assertIsNotNone(cb)
        self.assertEqual(cb.y, 45720)

    def test_no_anchor_defaults_to_top(self):
        para_xml = '<a:p><a:r><a:rPr lang="zh-CN" sz="1400"/><a:t>Test</a:t></a:r></a:p>'
        sp_xml = self._make_sp_xml_with_anchor("", para_xml, box_h=int(5 * EMU_PER_CM))
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement
        elem = _make_element(w=int(10 * EMU_PER_CM), h=int(5 * EMU_PER_CM))
        v = _make_validator()
        cb, _, _, _, _ = v._compute_text_content_bbox(sp_node, elem)
        self.assertIsNotNone(cb)
        self.assertEqual(cb.y, 45720)

    def test_center_anchor_shifts_content_down(self):
        cb_top = self._compute("t")
        cb_ctr = self._compute("ctr")
        self.assertIsNotNone(cb_top)
        self.assertIsNotNone(cb_ctr)
        self.assertGreater(cb_ctr.y, cb_top.y)

    def test_center_anchor_centered_vertically(self):
        box_h = int(5 * EMU_PER_CM)
        cb = self._compute("ctr", box_h=box_h)
        self.assertIsNotNone(cb)
        marT = 45720
        marB = 45720
        avail_h = box_h - marT - marB
        expected_y = marT + (avail_h - cb.h) // 2
        self.assertEqual(cb.y, expected_y)

    def test_bottom_anchor_at_bottom(self):
        box_h = int(5 * EMU_PER_CM)
        cb = self._compute("b", box_h=box_h)
        self.assertIsNotNone(cb)
        marT = 45720
        marB = 45720
        avail_h = box_h - marT - marB
        expected_y = marT + avail_h - cb.h
        self.assertEqual(cb.y, expected_y)

    def test_bottom_anchor_below_center(self):
        cb_ctr = self._compute("ctr")
        cb_b = self._compute("b")
        self.assertIsNotNone(cb_ctr)
        self.assertIsNotNone(cb_b)
        self.assertGreater(cb_b.y, cb_ctr.y)


# ---------------------------------------------------------------------------
# 25b. normAutofit 自动缩放 — content_h 不超过框高
# ---------------------------------------------------------------------------
class TestNormAutofit(unittest.TestCase):

    def _make_sp_xml_with_autofit(self, has_norm_autofit: bool, para_xml: str,
                                   box_w=int(10 * EMU_PER_CM), box_h=int(1 * EMU_PER_CM),
                                   font_scale=None):
        if has_norm_autofit:
            if font_scale is not None:
                autofit_child = f'<a:normAutofit fontScale="{font_scale}"/>'
            else:
                autofit_child = '<a:normAutofit/>'
        else:
            autofit_child = '<a:spAutoFit/>'
        return (
            f'<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            f' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            f'<p:nvSpPr><p:cNvPr id="1" name="TextBox 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{box_w}" cy="{box_h}"/></a:xfrm>'
            f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
            f'<p:txBody>'
            f'<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="ctr">'
            f'{autofit_child}</a:bodyPr>'
            f'<a:lstStyle/>'
            f'{para_xml}'
            f'</p:txBody>'
            f'</p:sp>'
        )

    def test_normAutofit_clamps_content_height(self):
        long_title = 'A' * 60
        para_xml = f'<a:p><a:r><a:rPr lang="en-US" sz="2600"/><a:t>{long_title}</a:t></a:r></a:p>'
        box_h = int(3 * EMU_PER_CM)
        sp_xml = self._make_sp_xml_with_autofit(True, para_xml, box_h=box_h, font_scale="50000")
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement
        elem = _make_element(w=int(10 * EMU_PER_CM), h=box_h, marL=0, marR=0, marT=0, marB=0)
        v = _make_validator()
        cb, _, _, _, _ = v._compute_text_content_bbox(sp_node, elem)
        self.assertIsNotNone(cb)
        self.assertLessEqual(cb.h, box_h)

    def test_normAutofit_no_fontscale_clamps_to_box(self):
        long_title = 'A' * 200
        para_xml = f'<a:p><a:r><a:rPr lang="en-US" sz="2600"/><a:t>{long_title}</a:t></a:r></a:p>'
        box_h = int(1 * EMU_PER_CM)
        sp_xml = self._make_sp_xml_with_autofit(True, para_xml, box_h=box_h)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement
        elem = _make_element(w=int(10 * EMU_PER_CM), h=box_h, marL=0, marR=0, marT=0, marB=0)
        v = _make_validator()
        cb, _, _, _, _ = v._compute_text_content_bbox(sp_node, elem)
        self.assertIsNotNone(cb)
        self.assertLessEqual(cb.h, box_h)

    def test_spAutoFit_also_clamps_content_h(self):
        long_title = 'A' * 200
        para_xml = f'<a:p><a:r><a:rPr lang="en-US" sz="2600"/><a:t>{long_title}</a:t></a:r></a:p>'
        box_h = int(1 * EMU_PER_CM)
        sp_xml = self._make_sp_xml_with_autofit(False, para_xml, box_h=box_h)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement
        elem = _make_element(w=int(10 * EMU_PER_CM), h=box_h, marL=0, marR=0, marT=0, marB=0)
        v = _make_validator()
        cb, _, _, _, _ = v._compute_text_content_bbox(sp_node, elem)
        self.assertIsNotNone(cb)
        self.assertLessEqual(cb.h, box_h)

    def test_normAutofit_short_text_no_clamp_needed(self):
        para_xml = '<a:p><a:r><a:rPr lang="en-US" sz="1400"/><a:t>Hi</a:t></a:r></a:p>'
        box_h = int(5 * EMU_PER_CM)
        sp_xml = self._make_sp_xml_with_autofit(True, para_xml, box_h=box_h)
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement
        elem = _make_element(w=int(10 * EMU_PER_CM), h=box_h, marL=0, marR=0, marT=0, marB=0)
        v = _make_validator()
        cb, _, _, _, _ = v._compute_text_content_bbox(sp_node, elem)
        self.assertIsNotNone(cb)
        self.assertLess(cb.h, box_h)

    def test_normAutofit_with_ctr_anchor_centers_clamped(self):
        long_title = 'A' * 60
        para_xml = f'<a:p><a:r><a:rPr lang="en-US" sz="2600"/><a:t>{long_title}</a:t></a:r></a:p>'
        box_h = int(3 * EMU_PER_CM)
        sp_xml = self._make_sp_xml_with_autofit(True, para_xml, box_h=box_h, font_scale="50000")
        sp_node = defusedxml.minidom.parseString(sp_xml).documentElement
        elem = _make_element(w=int(10 * EMU_PER_CM), h=box_h, marL=0, marR=0, marT=0, marB=0)
        v = _make_validator()
        cb, _, _, _, _ = v._compute_text_content_bbox(sp_node, elem)
        self.assertIsNotNone(cb)
        self.assertEqual(cb.h, box_h)
        self.assertEqual(cb.y, 0)


# ---------------------------------------------------------------------------
# 26. has_opaque_fill 检测（_extract_elements）
# ---------------------------------------------------------------------------
class TestHasOpaqueFill(unittest.TestCase):

    def _build_sp_tree_dom(self, children_xml: str):
        xml = (
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<p:cSld><p:spTree>'
            f'{children_xml}'
            '</p:spTree></p:cSld>'
            '</p:sld>'
        )
        return defusedxml.minidom.parseString(xml)

    def test_solid_fill_shape_has_opaque_fill(self):
        child_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="S1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="500"/></a:xfrm>'
            '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:spPr>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(child_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 1)
        self.assertTrue(elements[0].is_decorative)
        self.assertTrue(elements[0].has_opaque_fill)

    def test_no_fill_shape_not_opaque(self):
        child_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="S1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="500"/></a:xfrm></p:spPr>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(child_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 1)
        self.assertTrue(elements[0].is_decorative)
        self.assertFalse(elements[0].has_opaque_fill)

    def test_solid_fill_with_no_fill_not_opaque(self):
        child_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="S1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="500"/></a:xfrm>'
            '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>'
            '<a:noFill/></p:spPr>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(child_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 1)
        self.assertTrue(elements[0].is_decorative)
        self.assertFalse(elements[0].has_opaque_fill)

    def test_shape_with_text_not_decorative_not_opaque_checked(self):
        child_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3600000" cy="1800000"/></a:xfrm>'
            '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:r><a:t>hello</a:t></a:r></a:p></p:txBody>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(child_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 1)
        self.assertFalse(elements[0].is_decorative)
        self.assertFalse(elements[0].has_opaque_fill)


# ---------------------------------------------------------------------------
# 27. is_label_background (PAIRED) 检测
# ---------------------------------------------------------------------------
class TestLabelBackground(unittest.TestCase):

    def _build_sp_tree_dom(self, children_xml: str):
        xml = (
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<p:cSld><p:spTree>'
            f'{children_xml}'
            '</p:spTree></p:cSld>'
            '</p:sld>'
        )
        return defusedxml.minidom.parseString(xml)

    def test_paired_shape_text_same_bbox_marks_label_background(self):
        children_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="S1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm>'
            '<a:solidFill><a:srgbClr val="003366"/></a:solidFill></p:spPr>'
            '</p:sp>'
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="2" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Label</a:t></a:r></a:p></p:txBody>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(children_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 2)
        self.assertTrue(elements[0].is_label_background)
        self.assertFalse(elements[1].is_label_background)

    def test_different_bbox_not_label_background(self):
        children_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="S1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm>'
            '<a:solidFill><a:srgbClr val="003366"/></a:solidFill></p:spPr>'
            '</p:sp>'
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="2" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="500" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Label</a:t></a:r></a:p></p:txBody>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(children_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 2)
        self.assertFalse(elements[0].is_label_background)

    def test_non_opaque_fill_not_label_background(self):
        children_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="S1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm></p:spPr>'
            '</p:sp>'
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="2" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Label</a:t></a:r></a:p></p:txBody>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(children_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 2)
        self.assertFalse(elements[0].is_label_background)

    def test_next_element_no_text_not_label_background(self):
        children_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="S1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm>'
            '<a:solidFill><a:srgbClr val="003366"/></a:solidFill></p:spPr>'
            '</p:sp>'
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="2" name="S2"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm></p:spPr>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(children_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 2)
        self.assertFalse(elements[0].is_label_background)


# ---------------------------------------------------------------------------
# 28. 遮盖检测（occlusion: z-order + label_background 过滤 + 阈值）
# ---------------------------------------------------------------------------
class TestOcclusionDetection(unittest.TestCase):

    def test_opaque_shape_above_text_reports_occlusion(self):
        text_elem = _make_element(x=0, y=0, w=10000, h=10000,
                                  element_type="text", name="Title",
                                  has_text=True,
                                  content_bbox=BoundingBox(0, 0, 10000, 10000))
        shape_elem = _make_element(x=5000, y=5000, w=10000, h=10000,
                                   element_type="shape", name="Card",
                                   has_text=False, is_decorative=True)
        shape_elem.has_opaque_fill = True
        slide = _make_slide(elements=[text_elem, shape_elem])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 1)
        self.assertIn("Title", occlusion_issues[0].description)
        self.assertIn("Card", occlusion_issues[0].description)

    def test_opaque_shape_below_text_no_occlusion(self):
        shape_elem = _make_element(x=0, y=0, w=10000, h=10000,
                                   element_type="shape", name="Background",
                                   has_text=False, is_decorative=True)
        shape_elem.has_opaque_fill = True
        text_elem = _make_element(x=5000, y=5000, w=10000, h=10000,
                                  element_type="text", name="Title",
                                  has_text=True,
                                  content_bbox=BoundingBox(5000, 5000, 10000, 10000))
        slide = _make_slide(elements=[shape_elem, text_elem])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 0)

    def test_label_background_skipped_in_occlusion(self):
        text_elem = _make_element(x=0, y=0, w=10000, h=10000,
                                  element_type="text", name="Title",
                                  has_text=True,
                                  content_bbox=BoundingBox(0, 0, 10000, 10000))
        label_shape = _make_element(x=0, y=0, w=10000, h=10000,
                                    element_type="shape", name="LabelBg",
                                    has_text=False, is_decorative=True)
        label_shape.has_opaque_fill = True
        label_shape.is_label_background = True
        slide = _make_slide(elements=[text_elem, label_shape])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 0)

    def test_non_opaque_decorative_shape_no_occlusion(self):
        text_elem = _make_element(x=0, y=0, w=10000, h=10000,
                                  element_type="text", name="Title",
                                  has_text=True,
                                  content_bbox=BoundingBox(0, 0, 10000, 10000))
        shape_elem = _make_element(x=5000, y=5000, w=10000, h=10000,
                                   element_type="shape", name="Shape",
                                   has_text=False, is_decorative=True)
        shape_elem.has_opaque_fill = False
        slide = _make_slide(elements=[text_elem, shape_elem])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 0)

    def test_tiny_overlap_still_reported(self):
        text_elem = _make_element(x=0, y=0, w=100000, h=100000,
                                  element_type="text", name="Title",
                                  has_text=True,
                                  content_bbox=BoundingBox(0, 0, 100000, 100000))
        shape_elem = _make_element(x=99000, y=99000, w=100000, h=100000,
                                   element_type="shape", name="Card",
                                   has_text=False, is_decorative=True)
        shape_elem.has_opaque_fill = True
        slide = _make_slide(elements=[text_elem, shape_elem])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 1)

    def test_no_overlap_no_occlusion(self):
        text_elem = _make_element(x=0, y=0, w=1000, h=1000,
                                  element_type="text", name="Title",
                                  has_text=True,
                                  content_bbox=BoundingBox(0, 0, 1000, 1000))
        shape_elem = _make_element(x=90000, y=90000, w=1000, h=1000,
                                   element_type="shape", name="Card",
                                   has_text=False, is_decorative=True)
        shape_elem.has_opaque_fill = True
        slide = _make_slide(elements=[text_elem, shape_elem])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 0)

    def test_occlusion_priority_is_p0(self):
        text_elem = _make_element(x=0, y=0, w=10000, h=10000,
                                  element_type="text", name="Title",
                                  has_text=True,
                                  content_bbox=BoundingBox(0, 0, 10000, 10000))
        shape_elem = _make_element(x=0, y=0, w=10000, h=10000,
                                   element_type="shape", name="Card",
                                   has_text=False, is_decorative=True)
        shape_elem.has_opaque_fill = True
        slide = _make_slide(elements=[text_elem, shape_elem])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 1)
        self.assertEqual(occlusion_issues[0].priority, "P0")

    def test_both_decorative_no_occlusion(self):
        shape1 = _make_element(x=0, y=0, w=10000, h=10000,
                               element_type="shape", name="Shape1",
                               has_text=False, is_decorative=True)
        shape1.has_opaque_fill = True
        shape2 = _make_element(x=5000, y=5000, w=10000, h=10000,
                               element_type="shape", name="Shape2",
                               has_text=False, is_decorative=True)
        shape2.has_opaque_fill = True
        slide = _make_slide(elements=[shape1, shape2])
        v = _make_validator()
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 0)

    def test_occlusion_uses_content_bbox_not_bbox(self):
        text_elem = _make_element(x=0, y=0, w=100000, h=100000,
                                  element_type="text", name="Title",
                                  has_text=True,
                                  content_bbox=BoundingBox(10000, 10000, 30000, 30000))
        shape_elem = _make_element(x=20000, y=20000, w=50000, h=50000,
                                   element_type="shape", name="Card",
                                   has_text=False, is_decorative=True)
        shape_elem.has_opaque_fill = True
        slide = _make_slide(elements=[text_elem, shape_elem])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 1)

    def test_occlusion_no_overlap_with_content_bbox(self):
        text_elem = _make_element(x=0, y=0, w=100000, h=100000,
                                  element_type="text", name="Title",
                                  has_text=True,
                                  content_bbox=BoundingBox(0, 0, 10000, 10000))
        shape_elem = _make_element(x=50000, y=50000, w=10000, h=10000,
                                   element_type="shape", name="Card",
                                   has_text=False, is_decorative=True)
        shape_elem.has_opaque_fill = True
        slide = _make_slide(elements=[text_elem, shape_elem])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 0)

    def test_multiple_shapes_occlude_same_text(self):
        text_elem = _make_element(x=0, y=0, w=100000, h=100000,
                                  element_type="text", name="Title",
                                  has_text=True,
                                  content_bbox=BoundingBox(0, 0, 100000, 100000))
        shape1 = _make_element(x=0, y=0, w=50000, h=50000,
                               element_type="shape", name="Card1",
                               has_text=False, is_decorative=True)
        shape1.has_opaque_fill = True
        shape2 = _make_element(x=50000, y=50000, w=50000, h=50000,
                               element_type="shape", name="Card2",
                               has_text=False, is_decorative=True)
        shape2.has_opaque_fill = True
        slide = _make_slide(elements=[text_elem, shape1, shape2])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 2)
        names = sorted([i.elements[1].name for i in occlusion_issues])
        self.assertEqual(names, ["Card1", "Card2"])

    def test_non_text_content_not_occluded(self):
        image_elem = _make_element(x=0, y=0, w=10000, h=10000,
                                   element_type="image", name="Photo",
                                   has_text=False, is_decorative=False)
        shape_elem = _make_element(x=0, y=0, w=10000, h=10000,
                                   element_type="shape", name="Card",
                                   has_text=False, is_decorative=True)
        shape_elem.has_opaque_fill = True
        slide = _make_slide(elements=[image_elem, shape_elem])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 0)

    def test_occlusion_description_format(self):
        text_elem = _make_element(x=0, y=0, w=10000, h=10000,
                                  element_type="text", name="MyTitle",
                                  has_text=True,
                                  content_bbox=BoundingBox(0, 0, 10000, 10000))
        shape_elem = _make_element(x=0, y=0, w=10000, h=10000,
                                   element_type="shape", name="WhiteCard",
                                   has_text=False, is_decorative=True)
        shape_elem.has_opaque_fill = True
        slide = _make_slide(elements=[text_elem, shape_elem])
        v = _make_validator()
        v._check_element_overlaps(slide)
        occlusion_issues = [i for i in v.issues if "occluded" in i.description]
        self.assertEqual(len(occlusion_issues), 1)
        desc = occlusion_issues[0].description
        self.assertIn("'MyTitle'", desc)
        self.assertIn("occluded by", desc)
        self.assertIn("'WhiteCard'", desc)


# ---------------------------------------------------------------------------
# 29. PAIRED 标签背景 — 边界条件
# ---------------------------------------------------------------------------
class TestLabelBackgroundEdgeCases(unittest.TestCase):

    def _build_sp_tree_dom(self, children_xml: str):
        xml = (
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<p:cSld><p:spTree>'
            f'{children_xml}'
            '</p:spTree></p:cSld>'
            '</p:sld>'
        )
        return defusedxml.minidom.parseString(xml)

    def test_last_element_opaque_not_crash(self):
        children_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:txBody>'
            '</p:sp>'
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="2" name="S1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm>'
            '<a:solidFill><a:srgbClr val="003366"/></a:solidFill></p:spPr>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(children_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 2)
        self.assertFalse(elements[1].is_label_background)

    def test_multiple_paired_labels(self):
        children_xml = (
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="1" name="S1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm>'
            '<a:solidFill><a:srgbClr val="003366"/></a:solidFill></p:spPr>'
            '</p:sp>'
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="2" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Label1</a:t></a:r></a:p></p:txBody>'
            '</p:sp>'
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="3" name="S2"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="5000" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm>'
            '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>'
            '</p:sp>'
            '<p:sp>'
            '<p:nvSpPr><p:cNvPr id="4" name="T2"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="5000" y="200"/><a:ext cx="3000" cy="1000"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Label2</a:t></a:r></a:p></p:txBody>'
            '</p:sp>'
        )
        dom = self._build_sp_tree_dom(children_xml)
        v = _make_validator()
        elements = v._extract_elements(dom, "ppt/slides/slide1.xml")
        self.assertEqual(len(elements), 4)
        self.assertTrue(elements[0].is_label_background)
        self.assertFalse(elements[1].is_label_background)
        self.assertTrue(elements[2].is_label_background)
        self.assertFalse(elements[3].is_label_background)


# ---------------------------------------------------------------------------
# 30. normAutofit 集成：clamp 后不产生误报重叠
# ---------------------------------------------------------------------------
class TestNormAutofitIntegration(unittest.TestCase):

    def test_normAutofit_prevents_false_overlap(self):
        title = _make_element(x=0, y=0, w=int(10 * EMU_PER_CM), h=int(1 * EMU_PER_CM),
                              marL=0, marR=0, marT=0, marB=0,
                              element_type="text", name="Title", has_text=True,
                              content_bbox=BoundingBox(0, 0, int(10 * EMU_PER_CM), int(1 * EMU_PER_CM)))
        below = _make_element(x=0, y=int(1.5 * EMU_PER_CM),
                              w=int(10 * EMU_PER_CM), h=int(2 * EMU_PER_CM),
                              element_type="text", name="Body", has_text=True,
                              content_bbox=BoundingBox(0, int(1.5 * EMU_PER_CM),
                                                       int(10 * EMU_PER_CM), int(2 * EMU_PER_CM)))
        slide = _make_slide(elements=[title, below])
        v = _make_validator()
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 0)

    def test_unclamped_content_would_overlap(self):
        title = _make_element(x=0, y=0, w=int(10 * EMU_PER_CM), h=int(1 * EMU_PER_CM),
                              marL=0, marR=0, marT=0, marB=0,
                              element_type="text", name="Title", has_text=True,
                              content_bbox=BoundingBox(0, 0, int(10 * EMU_PER_CM), int(2 * EMU_PER_CM)))
        below = _make_element(x=0, y=int(1.5 * EMU_PER_CM),
                              w=int(10 * EMU_PER_CM), h=int(2 * EMU_PER_CM),
                              element_type="text", name="Body", has_text=True,
                              content_bbox=BoundingBox(0, int(1.5 * EMU_PER_CM),
                                                       int(10 * EMU_PER_CM), int(2 * EMU_PER_CM)))
        slide = _make_slide(elements=[title, below])
        v = _make_validator()
        v._check_element_overlaps(slide)
        overlap_issues = [i for i in v.issues if i.issue_type == "overlap"]
        self.assertGreater(len(overlap_issues), 0)


# ---------------------------------------------------------------------------
# 31. 背景图片 z-order 跳过重叠检测
# ---------------------------------------------------------------------------
class TestBackgroundImageSkip(unittest.TestCase):

    def test_image_below_text_no_overlap(self):
        image = _make_element(x=0, y=0, w=int(25 * EMU_PER_CM), h=int(14 * EMU_PER_CM),
                              element_type="image", name="Background",
                              has_text=False, is_decorative=False)
        text = _make_element(x=int(2 * EMU_PER_CM), y=int(2 * EMU_PER_CM),
                             w=int(20 * EMU_PER_CM), h=int(3 * EMU_PER_CM),
                             element_type="text", name="Title",
                             has_text=True,
                             content_bbox=BoundingBox(int(2 * EMU_PER_CM), int(2 * EMU_PER_CM),
                                                      int(20 * EMU_PER_CM), int(3 * EMU_PER_CM)))
        slide = _make_slide(elements=[image, text])
        v = _make_validator()
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 0)

    def test_image_above_text_reports_overlap(self):
        text = _make_element(x=0, y=0, w=int(20 * EMU_PER_CM), h=int(10 * EMU_PER_CM),
                             element_type="text", name="Title",
                             has_text=True,
                             content_bbox=BoundingBox(0, 0, int(20 * EMU_PER_CM), int(10 * EMU_PER_CM)))
        image = _make_element(x=0, y=0, w=int(25 * EMU_PER_CM), h=int(14 * EMU_PER_CM),
                              element_type="image", name="OverlayImage",
                              has_text=False, is_decorative=False)
        slide = _make_slide(elements=[text, image])
        v = _make_validator()
        v._check_element_overlaps(slide)
        overlap_issues = [i for i in v.issues if i.issue_type == "overlap"]
        self.assertGreater(len(overlap_issues), 0)

    def test_image_below_non_text_still_reports(self):
        image = _make_element(x=0, y=0, w=int(25 * EMU_PER_CM), h=int(14 * EMU_PER_CM),
                              element_type="image", name="Background",
                              has_text=False, is_decorative=False)
        shape = _make_element(x=int(2 * EMU_PER_CM), y=int(2 * EMU_PER_CM),
                              w=int(20 * EMU_PER_CM), h=int(10 * EMU_PER_CM),
                              element_type="image", name="Photo",
                              has_text=False, is_decorative=False)
        slide = _make_slide(elements=[image, shape])
        v = _make_validator()
        v._check_element_overlaps(slide)
        overlap_issues = [i for i in v.issues if i.issue_type == "overlap"]
        self.assertGreater(len(overlap_issues), 0)

    def test_multiple_texts_on_background_image_all_skip(self):
        image = _make_element(x=0, y=0, w=int(25 * EMU_PER_CM), h=int(14 * EMU_PER_CM),
                              element_type="image", name="Background",
                              has_text=False, is_decorative=False)
        t1 = _make_element(x=int(2 * EMU_PER_CM), y=int(2 * EMU_PER_CM),
                           w=int(20 * EMU_PER_CM), h=int(3 * EMU_PER_CM),
                           element_type="text", name="Title", has_text=True,
                           content_bbox=BoundingBox(int(2 * EMU_PER_CM), int(2 * EMU_PER_CM),
                                                    int(20 * EMU_PER_CM), int(3 * EMU_PER_CM)))
        t2 = _make_element(x=int(2 * EMU_PER_CM), y=int(6 * EMU_PER_CM),
                           w=int(20 * EMU_PER_CM), h=int(2 * EMU_PER_CM),
                           element_type="text", name="Subtitle", has_text=True,
                           content_bbox=BoundingBox(int(2 * EMU_PER_CM), int(6 * EMU_PER_CM),
                                                    int(20 * EMU_PER_CM), int(2 * EMU_PER_CM)))
        slide = _make_slide(elements=[image, t1, t2])
        v = _make_validator()
        v._check_element_overlaps(slide)
        image_overlaps = [i for i in v.issues if "Background" in i.description]
        self.assertEqual(len(image_overlaps), 0)


# ---------------------------------------------------------------------------
# 32. 页脚区域检测与侵入检测
# ---------------------------------------------------------------------------
class TestFooterDetection(unittest.TestCase):

    def _make_footer_slides(self, num_slides=6, footer_y=int(13.53 * EMU_PER_CM),
                            extra_elements_fn=None):
        slide_w = int(25.40 * EMU_PER_CM)
        slide_h = int(14.29 * EMU_PER_CM)
        slides = []
        for sn in range(1, num_slides + 1):
            footer_bar = _make_element(x=0, y=footer_y, w=slide_w, h=int(0.76 * EMU_PER_CM),
                                       element_type="shape", name="FooterBar",
                                       has_text=False, is_decorative=True)
            footer_bar.has_opaque_fill = True
            footer_text = _make_element(x=int(20 * EMU_PER_CM), y=footer_y,
                                        w=int(3 * EMU_PER_CM), h=int(0.76 * EMU_PER_CM),
                                        element_type="text", name="PageNum",
                                        has_text=True)
            elems = [footer_bar, footer_text]
            if extra_elements_fn:
                elems = extra_elements_fn(sn) + elems
            slides.append(SlideInfo(
                slide_number=sn,
                width=slide_w,
                height=slide_h,
                xml_path=f"ppt/slides/slide{sn}.xml",
                elements=elems
            ))
        return slides

    def test_footer_detected_when_consistent_bottom_bar(self):
        v = _make_validator()
        v.slides = self._make_footer_slides()
        v._detect_footer_region()
        self.assertIsNotNone(v.footer_top_y)
        self.assertEqual(v.footer_top_y, int(13.53 * EMU_PER_CM))

    def test_footer_elements_marked(self):
        v = _make_validator()
        v.slides = self._make_footer_slides()
        v._detect_footer_region()
        for slide in v.slides:
            self.assertTrue(slide.elements[0].is_footer)
            self.assertTrue(slide.elements[1].is_footer)

    def test_no_footer_when_too_few_slides(self):
        v = _make_validator()
        v.slides = self._make_footer_slides(num_slides=2)
        v._detect_footer_region()
        self.assertIsNone(v.footer_top_y)

    def test_no_footer_when_inconsistent(self):
        slide_w = int(25.40 * EMU_PER_CM)
        slide_h = int(14.29 * EMU_PER_CM)
        slides = []
        for sn in range(1, 6):
            y = int((10 + sn) * EMU_PER_CM)
            bar = _make_element(x=0, y=y, w=slide_w, h=int(0.5 * EMU_PER_CM),
                                element_type="shape", name="Bar", has_text=False,
                                is_decorative=True)
            bar.has_opaque_fill = True
            slides.append(SlideInfo(slide_number=sn, width=slide_w, height=slide_h,
                                    xml_path=f"ppt/slides/slide{sn}.xml", elements=[bar]))
        v = _make_validator()
        v.slides = slides
        v._detect_footer_region()
        self.assertIsNone(v.footer_top_y)


class TestFooterIntrusion(unittest.TestCase):

    def _setup_with_footer(self, content_elements):
        slide_w = int(25.40 * EMU_PER_CM)
        slide_h = int(14.29 * EMU_PER_CM)
        footer_y = int(13.53 * EMU_PER_CM)

        slides = []
        for sn in range(1, 5):
            footer_bar = _make_element(x=0, y=footer_y, w=slide_w, h=int(0.76 * EMU_PER_CM),
                                       element_type="shape", name="FooterBar",
                                       has_text=False, is_decorative=True)
            footer_bar.has_opaque_fill = True
            elems = [footer_bar]
            if sn == 2:
                elems = content_elements + elems
            slides.append(SlideInfo(slide_number=sn, width=slide_w, height=slide_h,
                                    xml_path=f"ppt/slides/slide{sn}.xml", elements=elems))
        v = _make_validator()
        v.slides = slides
        v._detect_footer_region()
        v._check_footer_intrusion(v.slides[1])
        return v

    def test_card_intruding_footer_reported(self):
        card = _make_element(x=int(2 * EMU_PER_CM), y=int(9 * EMU_PER_CM),
                             w=int(7 * EMU_PER_CM), h=int(5 * EMU_PER_CM),
                             element_type="shape", name="Card",
                             has_text=False, is_decorative=True)
        card.has_opaque_fill = True
        v = self._setup_with_footer([card])
        footer_issues = [i for i in v.issues if i.issue_type == "boundary" and "footer" in i.description]
        self.assertEqual(len(footer_issues), 1)
        self.assertIn("Card", footer_issues[0].description)

    def test_element_above_footer_no_issue(self):
        content = _make_element(x=int(2 * EMU_PER_CM), y=int(2 * EMU_PER_CM),
                                w=int(7 * EMU_PER_CM), h=int(5 * EMU_PER_CM),
                                element_type="text", name="Body", has_text=True)
        v = self._setup_with_footer([content])
        footer_issues = [i for i in v.issues if i.issue_type == "boundary" and "footer" in i.description]
        self.assertEqual(len(footer_issues), 0)

    def test_fullpage_image_skipped(self):
        image = _make_element(x=0, y=0, w=int(25.40 * EMU_PER_CM), h=int(14.29 * EMU_PER_CM),
                              element_type="image", name="BgImage",
                              has_text=False, is_decorative=False)
        v = self._setup_with_footer([image])
        footer_issues = [i for i in v.issues if i.issue_type == "boundary" and "footer" in i.description]
        self.assertEqual(len(footer_issues), 0)

    def test_fullheight_decorative_line_skipped(self):
        line = _make_element(x=0, y=0, w=int(0.2 * EMU_PER_CM), h=int(14.29 * EMU_PER_CM),
                             element_type="shape", name="DecoLine",
                             has_text=False, is_decorative=True)
        line.has_opaque_fill = True
        v = self._setup_with_footer([line])
        footer_issues = [i for i in v.issues if i.issue_type == "boundary" and "footer" in i.description]
        self.assertEqual(len(footer_issues), 0)

    def test_footer_elements_skip_overlap_with_each_other(self):
        text1 = _make_element(x=0, y=int(13.53 * EMU_PER_CM),
                              w=int(5 * EMU_PER_CM), h=int(0.76 * EMU_PER_CM),
                              element_type="text", name="FooterText1",
                              has_text=True,
                              content_bbox=BoundingBox(0, int(13.53 * EMU_PER_CM),
                                                       int(5 * EMU_PER_CM), int(0.76 * EMU_PER_CM)))
        text1.is_footer = True
        text2 = _make_element(x=0, y=int(13.53 * EMU_PER_CM),
                              w=int(5 * EMU_PER_CM), h=int(0.76 * EMU_PER_CM),
                              element_type="text", name="FooterText2",
                              has_text=True,
                              content_bbox=BoundingBox(0, int(13.53 * EMU_PER_CM),
                                                       int(5 * EMU_PER_CM), int(0.76 * EMU_PER_CM)))
        text2.is_footer = True
        slide = _make_slide(elements=[text1, text2])
        v = _make_validator()
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 0)

    def test_intrusion_priority_is_p0(self):
        card = _make_element(x=int(2 * EMU_PER_CM), y=int(9 * EMU_PER_CM),
                             w=int(7 * EMU_PER_CM), h=int(5 * EMU_PER_CM),
                             element_type="shape", name="Card",
                             has_text=False, is_decorative=True)
        card.has_opaque_fill = True
        v = self._setup_with_footer([card])
        footer_issues = [i for i in v.issues if i.issue_type == "boundary" and "footer" in i.description]
        self.assertEqual(len(footer_issues), 1)
        self.assertEqual(footer_issues[0].priority, "P0")


class TestFooterIntrusionTolerance(unittest.TestCase):

    def _setup_with_footer(self, content_elements, footer_y=int(13.53 * EMU_PER_CM)):
        slide_w = int(25.40 * EMU_PER_CM)
        slide_h = int(14.29 * EMU_PER_CM)
        slides = []
        for sn in range(1, 5):
            footer_bar = _make_element(x=0, y=footer_y, w=slide_w, h=int(0.76 * EMU_PER_CM),
                                       element_type="shape", name="FooterBar",
                                       has_text=False, is_decorative=True)
            footer_bar.has_opaque_fill = True
            elems = [footer_bar]
            if sn == 2:
                elems = content_elements + elems
            slides.append(SlideInfo(slide_number=sn, width=slide_w, height=slide_h,
                                    xml_path=f"ppt/slides/slide{sn}.xml", elements=elems))
        v = _make_validator()
        v.slides = slides
        v._detect_footer_region()
        v._check_footer_intrusion(v.slides[1])
        return v

    def test_intrusion_within_tolerance_not_reported(self):
        footer_y = int(13.53 * EMU_PER_CM)
        intrusion = int(0.02 * EMU_PER_CM)
        card = _make_element(x=int(2 * EMU_PER_CM), y=int(10 * EMU_PER_CM),
                             w=int(7 * EMU_PER_CM),
                             h=footer_y + intrusion - int(10 * EMU_PER_CM),
                             element_type="shape", name="Card",
                             has_text=False, is_decorative=True)
        card.has_opaque_fill = True
        v = self._setup_with_footer([card])
        boundary = [i for i in v.issues if i.issue_type == "boundary" and "footer" in i.description]
        self.assertEqual(len(boundary), 0, "侵入 0.02cm 在容差内不应报告")

    def test_intrusion_exceeding_tolerance_reported(self):
        footer_y = int(13.53 * EMU_PER_CM)
        intrusion = int(0.15 * EMU_PER_CM)
        card = _make_element(x=int(2 * EMU_PER_CM), y=int(10 * EMU_PER_CM),
                             w=int(7 * EMU_PER_CM),
                             h=footer_y + intrusion - int(10 * EMU_PER_CM),
                             element_type="shape", name="Card",
                             has_text=False, is_decorative=True)
        card.has_opaque_fill = True
        v = self._setup_with_footer([card])
        boundary = [i for i in v.issues if i.issue_type == "boundary" and "footer" in i.description]
        self.assertEqual(len(boundary), 1, "侵入 0.15cm 超过容差应报告")

    def test_intrusion_issue_type_is_boundary(self):
        card = _make_element(x=int(2 * EMU_PER_CM), y=int(9 * EMU_PER_CM),
                             w=int(7 * EMU_PER_CM), h=int(5 * EMU_PER_CM),
                             element_type="shape", name="Card",
                             has_text=False, is_decorative=True)
        card.has_opaque_fill = True
        v = self._setup_with_footer([card])
        all_issues = [i for i in v.issues if "footer" in i.description]
        for issue in all_issues:
            self.assertEqual(issue.issue_type, "boundary",
                             "footer 侵入问题应归入 boundary 类型")

    def test_textbox_uses_effective_bbox_for_intrusion(self):
        footer_y = int(13.53 * EMU_PER_CM)
        box_y = int(12.5 * EMU_PER_CM)
        box_h = int(1.0 * EMU_PER_CM)
        mar_t = int(0.13 * EMU_PER_CM)
        mar_b = int(0.13 * EMU_PER_CM)
        content_h = int(0.4 * EMU_PER_CM)
        content_y = box_y + mar_t
        text_elem = _make_element(x=int(2 * EMU_PER_CM), y=box_y,
                                  w=int(10 * EMU_PER_CM), h=box_h,
                                  element_type="text", name="TextBox",
                                  has_text=True, marT=mar_t, marB=mar_b,
                                  content_bbox=BoundingBox(int(2 * EMU_PER_CM), content_y,
                                                           int(5 * EMU_PER_CM), content_h))
        eff_bottom = content_y + content_h
        self.assertLess(eff_bottom, footer_y, "有效文本底部低于 footer，不应报告")
        v = self._setup_with_footer([text_elem])
        boundary = [i for i in v.issues if i.issue_type == "boundary" and "footer" in i.description]
        self.assertEqual(len(boundary), 0)

    def test_textbox_effective_bbox_exceeding_footer(self):
        footer_y = int(13.53 * EMU_PER_CM)
        box_y = int(12.5 * EMU_PER_CM)
        box_h = int(2.0 * EMU_PER_CM)
        content_y = box_y + int(0.17 * EMU_PER_CM)
        content_h = int(1.5 * EMU_PER_CM)
        text_elem = _make_element(x=int(2 * EMU_PER_CM), y=box_y,
                                  w=int(10 * EMU_PER_CM), h=box_h,
                                  element_type="text", name="TextBox",
                                  has_text=True,
                                  content_bbox=BoundingBox(int(2 * EMU_PER_CM), content_y,
                                                           int(5 * EMU_PER_CM), content_h))
        eff_bottom = content_y + content_h
        self.assertGreater(eff_bottom, footer_y, "有效文本底部超过 footer")
        v = self._setup_with_footer([text_elem])
        boundary = [i for i in v.issues if i.issue_type == "boundary" and "footer" in i.description]
        self.assertGreaterEqual(len(boundary), 1, "文字实际超出页脚应报告")

    def test_non_footer_element_starting_in_footer_area_detected(self):
        footer_y = int(13.53 * EMU_PER_CM)
        elem_y = footer_y + int(0.2 * EMU_PER_CM)
        elem_h = int(1.0 * EMU_PER_CM)
        content_y = elem_y + int(0.13 * EMU_PER_CM)
        content_h = int(0.5 * EMU_PER_CM)
        text_elem = _make_element(x=int(2 * EMU_PER_CM), y=elem_y,
                                  w=int(10 * EMU_PER_CM), h=elem_h,
                                  element_type="text", name="OverflowText",
                                  has_text=True,
                                  content_bbox=BoundingBox(int(2 * EMU_PER_CM), content_y,
                                                           int(5 * EMU_PER_CM), content_h))
        v = self._setup_with_footer([text_elem])
        boundary = [i for i in v.issues if i.issue_type == "boundary" and "footer" in i.description]
        self.assertGreaterEqual(len(boundary), 1,
                                "起始于页脚区域的非 footer 元素若超过容差仍应检测")


class TestFooterMarkingExcludesOverflow(unittest.TestCase):

    def test_element_exceeding_page_not_marked_footer(self):
        slide_w = int(25.40 * EMU_PER_CM)
        slide_h = int(14.29 * EMU_PER_CM)
        footer_y = int(13.53 * EMU_PER_CM)
        slides = []
        for sn in range(1, 5):
            footer_bar = _make_element(x=0, y=footer_y, w=slide_w, h=int(0.76 * EMU_PER_CM),
                                       element_type="shape", name="FooterBar",
                                       has_text=False, is_decorative=True)
            footer_bar.has_opaque_fill = True
            overflow = _make_element(x=int(2 * EMU_PER_CM), y=footer_y + int(0.2 * EMU_PER_CM),
                                     w=int(10 * EMU_PER_CM), h=int(1.5 * EMU_PER_CM),
                                     element_type="text", name="Overflow",
                                     has_text=True)
            elems = [footer_bar, overflow]
            slides.append(SlideInfo(slide_number=sn, width=slide_w, height=slide_h,
                                    xml_path=f"ppt/slides/slide{sn}.xml", elements=elems))
        v = _make_validator()
        v.slides = slides
        v._detect_footer_region()
        overflow_elem = v.slides[0].elements[1]
        overflow_bottom = (overflow_elem.bbox.y + overflow_elem.bbox.h) / EMU_PER_CM
        self.assertGreater(overflow_bottom, slide_h / EMU_PER_CM,
                           "溢出元素底部超出页面")
        self.assertFalse(overflow_elem.is_footer,
                         "超出页面底部的元素不应被标记为 footer")

    def test_element_within_footer_area_marked_footer(self):
        slide_w = int(25.40 * EMU_PER_CM)
        slide_h = int(14.29 * EMU_PER_CM)
        footer_y = int(13.53 * EMU_PER_CM)
        slides = []
        for sn in range(1, 5):
            footer_bar = _make_element(x=0, y=footer_y, w=slide_w, h=int(0.76 * EMU_PER_CM),
                                       element_type="shape", name="FooterBar",
                                       has_text=False, is_decorative=True)
            footer_bar.has_opaque_fill = True
            footer_text = _make_element(x=int(20 * EMU_PER_CM), y=footer_y,
                                        w=int(3 * EMU_PER_CM), h=int(0.76 * EMU_PER_CM),
                                        element_type="text", name="PageNum",
                                        has_text=True)
            elems = [footer_bar, footer_text]
            slides.append(SlideInfo(slide_number=sn, width=slide_w, height=slide_h,
                                    xml_path=f"ppt/slides/slide{sn}.xml", elements=elems))
        v = _make_validator()
        v.slides = slides
        v._detect_footer_region()
        page_num = v.slides[0].elements[1]
        self.assertTrue(page_num.is_footer,
                        "位于 footer 区域内且未超出页面的元素应标记为 footer")


class TestBoundaryCheckWithContentBbox(unittest.TestCase):

    def test_content_bbox_exceeding_page_no_issue_when_estimate_within(self):
        slide_h = int(14.29 * EMU_PER_CM)
        box_y = int(13.5 * EMU_PER_CM)
        box_h = int(1.0 * EMU_PER_CM)
        content_y = box_y + int(0.13 * EMU_PER_CM)
        content_h = int(0.8 * EMU_PER_CM)
        text_elem = _make_element(x=int(2 * EMU_PER_CM), y=box_y,
                                  w=int(10 * EMU_PER_CM), h=box_h,
                                  element_type="text", name="Text Box",
                                  has_text=True, marT=int(0.13 * EMU_PER_CM), marB=int(0.13 * EMU_PER_CM),
                                  content_bbox=BoundingBox(int(2 * EMU_PER_CM), content_y,
                                                           int(5 * EMU_PER_CM), content_h))
        eff_bottom = content_y + content_h
        self.assertGreater(eff_bottom, slide_h, "content_bbox 底部应超出页面")

        sp_xml = (
            '<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<p:nvSpPr><p:cNvPr id="1" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="{int(2*EMU_PER_CM)}" y="{box_y}"/>'
            f'<a:ext cx="{int(10*EMU_PER_CM)}" cy="{box_h}"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>'
            '<a:p><a:r><a:rPr lang="zh-CN" sz="1000"/><a:t>短</a:t></a:r></a:p>'
            '</p:txBody></p:sp>'
        )
        slide_xml = (
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            f'<p:cSld><p:spTree>{sp_xml}</p:spTree></p:cSld></p:sld>'
        )
        dom = defusedxml.minidom.parseString(slide_xml)
        slide = _make_slide(height=slide_h, elements=[text_elem])
        slide.xml_path = "ppt/slides/slide1.xml"
        v = _make_validator()
        v._slide_doms["ppt/slides/slide1.xml"] = dom
        v.slides = [slide]
        v._check_slide_boundaries(slide)
        boundary_issues = [i for i in v.issues if i.issue_type == "boundary"]
        self.assertEqual(len(boundary_issues), 0,
                         "当估算内容未超出页面时，即使 content_bbox 被 clamp 超出也不应报告")

    def test_content_bbox_within_page_no_issue(self):
        slide_h = int(14.29 * EMU_PER_CM)
        box_y = int(13.5 * EMU_PER_CM)
        box_h = int(1.0 * EMU_PER_CM)
        content_y = box_y + int(0.13 * EMU_PER_CM)
        content_h = int(0.3 * EMU_PER_CM)
        text_elem = _make_element(x=int(2 * EMU_PER_CM), y=box_y,
                                  w=int(10 * EMU_PER_CM), h=box_h,
                                  element_type="text", name="Text Box",
                                  has_text=True, marT=int(0.13 * EMU_PER_CM), marB=int(0.13 * EMU_PER_CM),
                                  content_bbox=BoundingBox(int(2 * EMU_PER_CM), content_y,
                                                           int(5 * EMU_PER_CM), content_h))
        eff_bottom = content_y + content_h
        self.assertLess(eff_bottom, slide_h)

        sp_xml = (
            '<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<p:nvSpPr><p:cNvPr id="1" name="T1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="{int(2*EMU_PER_CM)}" y="{box_y}"/>'
            f'<a:ext cx="{int(10*EMU_PER_CM)}" cy="{box_h}"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>'
            '<a:p><a:r><a:rPr lang="zh-CN" sz="1000"/><a:t>短</a:t></a:r></a:p>'
            '</p:txBody></p:sp>'
        )
        slide_xml = (
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            f'<p:cSld><p:spTree>{sp_xml}</p:spTree></p:cSld></p:sld>'
        )
        dom = defusedxml.minidom.parseString(slide_xml)
        slide = _make_slide(height=slide_h, elements=[text_elem])
        slide.xml_path = "ppt/slides/slide1.xml"
        v = _make_validator()
        v._slide_doms["ppt/slides/slide1.xml"] = dom
        v.slides = [slide]
        v._check_slide_boundaries(slide)
        boundary_issues = [i for i in v.issues if i.issue_type == "boundary"]
        self.assertEqual(len(boundary_issues), 0,
                         "content_bbox 和 estimate 都未超出页面不应报告")


class TestSlideFilter(unittest.TestCase):

    def _make_multi_slide_validator(self, slide_filter=None):
        slide_w = int(25.40 * EMU_PER_CM)
        slide_h = int(14.29 * EMU_PER_CM)
        overflow_elem = _make_element(
            x=int(24 * EMU_PER_CM), y=int(1 * EMU_PER_CM),
            w=int(3 * EMU_PER_CM), h=int(1 * EMU_PER_CM),
            element_type="shape", name="Overflow",
            has_text=False, is_decorative=True)
        overflow_elem.has_opaque_fill = True
        slides = []
        for sn in range(1, 4):
            elems = [overflow_elem] if sn == 2 else []
            slides.append(SlideInfo(slide_number=sn, width=slide_w, height=slide_h,
                                    xml_path=f"ppt/slides/slide{sn}.xml", elements=elems))
        v = _make_validator()
        v.slide_filter = slide_filter
        v.slides = slides
        for slide in v.slides:
            if v.slide_filter and slide.slide_number not in v.slide_filter:
                continue
            v._check_slide_boundaries(slide)
        return v

    def test_no_filter_validates_all(self):
        v = self._make_multi_slide_validator(slide_filter=None)
        boundary = [i for i in v.issues if i.issue_type == "boundary"]
        self.assertEqual(len(boundary), 1)
        self.assertEqual(boundary[0].slide_number, 2)

    def test_filter_includes_affected_slide(self):
        v = self._make_multi_slide_validator(slide_filter={2})
        boundary = [i for i in v.issues if i.issue_type == "boundary"]
        self.assertEqual(len(boundary), 1)

    def test_filter_excludes_affected_slide(self):
        v = self._make_multi_slide_validator(slide_filter={1, 3})
        self.assertEqual(len(v.issues), 0)

    def test_filter_with_nonexistent_slide(self):
        v = self._make_multi_slide_validator(slide_filter={99})
        self.assertEqual(len(v.issues), 0)


class TestBorderOcclusionDetection(unittest.TestCase):

    def _make_opaque_deco(self, x, y, w, h, line_width=0, name="Shape"):
        e = _make_element(x=x, y=y, w=w, h=h, element_type="shape",
                          name=name, has_text=False, is_decorative=True)
        e.has_opaque_fill = True
        e.line_width = line_width
        return e

    def test_adjacent_opaque_shapes_border_occluded(self):
        bordered = self._make_opaque_deco(
            x=int(5 * EMU_PER_CM), y=int(3 * EMU_PER_CM),
            w=int(4 * EMU_PER_CM), h=int(2 * EMU_PER_CM),
            line_width=12700, name="Card")
        blocker = self._make_opaque_deco(
            x=int(5 * EMU_PER_CM), y=int(5 * EMU_PER_CM),
            w=int(4 * EMU_PER_CM), h=int(3 * EMU_PER_CM),
            name="Background")
        slide = _make_slide(elements=[bordered, blocker])
        v = _make_validator()
        v.slides = [slide]
        v._check_element_overlaps(slide)
        overlap_issues = [i for i in v.issues if i.issue_type == "overlap"]
        self.assertEqual(len(overlap_issues), 1)
        self.assertIn("border occluded", overlap_issues[0].description)

    def test_opaque_shapes_with_gap_no_issue(self):
        bordered = self._make_opaque_deco(
            x=int(5 * EMU_PER_CM), y=int(3 * EMU_PER_CM),
            w=int(4 * EMU_PER_CM), h=int(2 * EMU_PER_CM),
            line_width=12700, name="Card")
        blocker = self._make_opaque_deco(
            x=int(5 * EMU_PER_CM), y=int(5.5 * EMU_PER_CM),
            w=int(4 * EMU_PER_CM), h=int(3 * EMU_PER_CM),
            name="Background")
        slide = _make_slide(elements=[bordered, blocker])
        v = _make_validator()
        v.slides = [slide]
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 0)

    def test_child_inside_parent_no_issue(self):
        parent = self._make_opaque_deco(
            x=int(5 * EMU_PER_CM), y=int(3 * EMU_PER_CM),
            w=int(6 * EMU_PER_CM), h=int(4 * EMU_PER_CM),
            line_width=12700, name="Card")
        accent = self._make_opaque_deco(
            x=int(5 * EMU_PER_CM), y=int(3 * EMU_PER_CM),
            w=int(0.15 * EMU_PER_CM), h=int(4 * EMU_PER_CM),
            name="AccentBar")
        slide = _make_slide(elements=[parent, accent])
        v = _make_validator()
        v.slides = [slide]
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 0)

    def test_no_border_no_issue(self):
        shape1 = self._make_opaque_deco(
            x=int(5 * EMU_PER_CM), y=int(3 * EMU_PER_CM),
            w=int(4 * EMU_PER_CM), h=int(2 * EMU_PER_CM),
            line_width=0, name="Shape1")
        shape2 = self._make_opaque_deco(
            x=int(5 * EMU_PER_CM), y=int(5 * EMU_PER_CM),
            w=int(4 * EMU_PER_CM), h=int(3 * EMU_PER_CM),
            line_width=0, name="Shape2")
        slide = _make_slide(elements=[shape1, shape2])
        v = _make_validator()
        v.slides = [slide]
        v._check_element_overlaps(slide)
        self.assertEqual(len(v.issues), 0)


class TestHexToRgb(unittest.TestCase):

    def test_black(self):
        self.assertEqual(PPTXLayoutValidator._hex_to_rgb("000000"), (0, 0, 0))

    def test_white(self):
        self.assertEqual(PPTXLayoutValidator._hex_to_rgb("FFFFFF"), (255, 255, 255))

    def test_with_hash_prefix(self):
        self.assertEqual(PPTXLayoutValidator._hex_to_rgb("#FF8000"), (255, 128, 0))

    def test_arbitrary_color(self):
        self.assertEqual(PPTXLayoutValidator._hex_to_rgb("1A2B3C"), (26, 43, 60))


class TestContrastRatio(unittest.TestCase):

    def setUp(self):
        self.v = _make_validator()

    def test_black_on_white(self):
        ratio = self.v._contrast_ratio("000000", "FFFFFF")
        self.assertAlmostEqual(ratio, 21.0, places=0)

    def test_same_color(self):
        ratio = self.v._contrast_ratio("888888", "888888")
        self.assertAlmostEqual(ratio, 1.0, places=2)

    def test_symmetry(self):
        r1 = self.v._contrast_ratio("FF0000", "00FF00")
        r2 = self.v._contrast_ratio("00FF00", "FF0000")
        self.assertAlmostEqual(r1, r2, places=5)

    def test_low_contrast_pair(self):
        ratio = self.v._contrast_ratio("CCCCCC", "DDDDDD")
        self.assertLess(ratio, 1.5)


class TestCheckLowContrast(unittest.TestCase):

    def _run(self, elements):
        v = _make_validator()
        slide = _make_slide(elements=elements)
        v._check_low_contrast(slide)
        return v.issues

    def test_good_contrast_no_issue(self):
        e = _make_element(fill_color="FFFFFF", text_color="000000")
        issues = self._run([e])
        self.assertEqual(len(issues), 0)

    def test_low_contrast_detected(self):
        e = _make_element(fill_color="CCCCCC", text_color="DDDDDD")
        issues = self._run([e])
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].issue_type, "low_contrast")

    def test_no_text_color_skipped(self):
        e = _make_element(fill_color="FFFFFF", text_color=None)
        issues = self._run([e])
        self.assertEqual(len(issues), 0)

    def test_no_fill_uses_behind_element(self):
        bg = _make_element(x=0, y=0, w=100000, h=100000,
                           fill_color="DDDDDD", has_text=False, element_type="shape",
                           is_decorative=True)
        fg = _make_element(x=0, y=0, w=50000, h=50000,
                           fill_color=None, text_color="CCCCCC")
        issues = self._run([bg, fg])
        self.assertEqual(len(issues), 1)

    def test_alpha_blending(self):
        e = _make_element(fill_color="000000", fill_alpha=0.0, text_color="000000")
        issues = self._run([e])
        self.assertEqual(len(issues), 0)

    def test_non_text_element_skipped(self):
        e = _make_element(fill_color="CCCCCC", text_color="DDDDDD",
                          element_type="image", name="Picture", has_text=True)
        issues = self._run([e])
        self.assertEqual(len(issues), 0)


class TestCheckArrowDangling(unittest.TestCase):

    def _run(self, elements):
        v = _make_validator()
        slide = _make_slide(elements=elements)
        v._check_arrow_dangling(slide)
        return v.issues

    def test_arrow_connected_to_box_edge(self):
        box = _make_element(x=0, y=0, w=200000, h=200000,
                            element_type="shape", name="Rect", has_text=False,
                            is_decorative=True)
        arrow = _make_element(x=200000, y=100000, w=100000, h=0,
                              element_type="connector", name="Arrow",
                              is_connector=True, is_arrow=True, has_text=False,
                              arrow_endpoints=((200000, 100000), (300000, 100000)))
        box2 = _make_element(x=300000, y=0, w=200000, h=200000,
                             element_type="shape", name="Rect2", has_text=False,
                             is_decorative=True)
        issues = self._run([box, arrow, box2])
        self.assertEqual(len(issues), 0)

    def test_arrow_both_endpoints_dangling(self):
        arrow = _make_element(x=500000, y=500000, w=100000, h=0,
                              element_type="connector", name="Arrow",
                              is_connector=True, is_arrow=True, has_text=False,
                              arrow_endpoints=((500000, 500000), (600000, 500000)))
        issues = self._run([arrow])
        self.assertEqual(len(issues), 1)
        self.assertIn("head and tail", issues[0].description)

    def test_arrow_one_endpoint_dangling(self):
        box = _make_element(x=0, y=0, w=200000, h=200000,
                            element_type="shape", name="Rect", has_text=False,
                            is_decorative=True)
        arrow = _make_element(x=200000, y=100000, w=300000, h=0,
                              element_type="connector", name="Arrow",
                              is_connector=True, is_arrow=True, has_text=False,
                              arrow_endpoints=((200000, 100000), (800000, 100000)))
        issues = self._run([box, arrow])
        self.assertEqual(len(issues), 1)
        self.assertIn("tail", issues[0].description)

    def test_no_arrows_no_issue(self):
        box = _make_element(x=0, y=0, w=200000, h=200000)
        issues = self._run([box])
        self.assertEqual(len(issues), 0)


class TestLabelBackgroundOcclusion(unittest.TestCase):

    def _run(self, elements):
        v = _make_validator()
        slide = _make_slide(elements=elements)
        v._check_element_overlaps(slide)
        return v.issues

    def test_label_bg_skips_own_pair(self):
        label_bg = _make_element(x=0, y=0, w=10000, h=10000,
                                 element_type="shape", name="Shape",
                                 has_text=False, is_decorative=True,
                                 has_opaque_fill=True, is_label_background=True)
        label_text = _make_element(x=0, y=0, w=10000, h=10000,
                                   name="Text 1", has_text=True)
        slide = _make_slide(elements=[label_text, label_bg])
        v = _make_validator()
        v._check_element_overlaps(slide)
        overlap_issues = [i for i in v.issues if "Shape" in i.description and "Text 1" in i.description]
        self.assertEqual(len(overlap_issues), 0)

    def test_label_bg_detects_other_text_occlusion(self):
        other_text = _make_element(x=0, y=500000, w=10000000, h=2000000,
                                   name="Title", has_text=True,
                                   content_bbox=BoundingBox(0, 500000, 10000000, 2000000))
        label_bg = _make_element(x=0, y=0, w=2000000, h=2000000,
                                 element_type="shape", name="Shape",
                                 has_text=False, is_decorative=True,
                                 has_opaque_fill=True, is_label_background=True)
        label_text = _make_element(x=0, y=0, w=2000000, h=2000000,
                                   name="Text Num", has_text=True)
        issues = self._run([other_text, label_bg, label_text])
        occlusion_issues = [i for i in issues if "Title" in i.description and "Shape" in i.description]
        self.assertGreater(len(occlusion_issues), 0)


class TestCheckBlankSlide(unittest.TestCase):

    def _run(self, elements):
        v = _make_validator()
        slide = _make_slide(elements=elements)
        v._check_blank_slide(slide)
        return v.issues

    def test_blank_slide_detected(self):
        issues = self._run([])
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].issue_type, "blank_slide")
        self.assertEqual(issues[0].priority, "P0")

    def test_slide_with_elements_no_issue(self):
        e = _make_element(x=0, y=0, w=100000, h=100000)
        issues = self._run([e])
        self.assertEqual(len(issues), 0)


_TEST_DIR = Path(__file__).resolve().parent.parent / "test"


def _make_golden_test(pptx_path: Path, golden_path: Path):
    def test_method(self):
        import re
        golden_text = golden_path.read_text(encoding="utf-8")
        golden_lines = []
        m = re.search(r"<!-- GOLDEN_KEYS\n(.*?)\n-->", golden_text, re.DOTALL)
        if m:
            golden_lines = sorted([l for l in m.group(1).split("\n") if l.strip()])

        v = PPTXLayoutValidator(str(pptx_path), verbose=False)
        v.validate()
        actual_lines = sorted([_issue_to_golden_key(i) for i in v.issues])

        if actual_lines != golden_lines:
            golden_set = set(golden_lines)
            actual_set = set(actual_lines)
            added = sorted(actual_set - golden_set)
            removed = sorted(golden_set - actual_set)
            diff_parts = []
            for line in added:
                diff_parts.append(f"  + {line}")
            for line in removed:
                diff_parts.append(f"  - {line}")
            self.fail(
                f"{pptx_path.name}: expected {len(golden_lines)} issues, got {len(actual_lines)}\n"
                + "\n".join(diff_parts)
            )
    return test_method


class TestGoldenRegression(unittest.TestCase):
    pass


if _TEST_DIR.is_dir():
    for _gf in sorted(_TEST_DIR.glob("*.pptx.golden.md")):
        _pptx = _gf.parent / _gf.name.replace(".golden.md", "")
        if _pptx.exists():
            _test_name = f"test_golden_{_pptx.stem}"
            setattr(TestGoldenRegression, _test_name, _make_golden_test(_pptx, _gf))


if __name__ == "__main__":
    unittest.main()
