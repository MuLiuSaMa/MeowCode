import io
import json
import os
import platform
import sys

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Frame


CJK_FONT_REGISTERED = False
CJK_FONT_NAME = None


def contains_non_ascii(text):
    """Check if text contains non-ASCII characters (e.g., Chinese, Japanese, Korean)"""
    return any(ord(char) > 127 for char in text)


def get_cjk_font_path():
    """Get a CJK-capable font path based on the operating system"""
    system = platform.system()
    
    font_candidates = []
    
    if system == "Darwin":
        font_candidates = [
            "/Library/Fonts/Arial Unicode.ttf",
            "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
            "/System/Library/Fonts/STHeiti Medium.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/PingFang.ttc",
        ]
    elif system == "Windows":
        font_candidates = [
            "C:/Windows/Fonts/msyh.ttc",
            "C:/Windows/Fonts/simsun.ttc",
            "C:/Windows/Fonts/simhei.ttf",
            "C:/Windows/Fonts/arial.ttf",
        ]
    else:
        font_candidates = [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
            "/usr/share/fonts/truetype/arphic/uming.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    
    for font_path in font_candidates:
        if os.path.exists(font_path):
            return font_path
    
    return None


def register_cjk_font():
    """Register a CJK-capable font with reportlab"""
    global CJK_FONT_REGISTERED, CJK_FONT_NAME
    
    if CJK_FONT_REGISTERED:
        return CJK_FONT_NAME
    
    font_path = get_cjk_font_path()
    if font_path:
        try:
            CJK_FONT_NAME = "CJKFont"
            pdfmetrics.registerFont(TTFont(CJK_FONT_NAME, font_path, subfontIndex=0))
            CJK_FONT_REGISTERED = True
            return CJK_FONT_NAME
        except Exception as e:
            print(f"Warning: Failed to register CJK font from {font_path}: {e}", file=sys.stderr)
    
    return None


def get_font_for_text(text, requested_font):
    """Get the appropriate font name for the text content"""
    if contains_non_ascii(text):
        cjk_font = register_cjk_font()
        if cjk_font:
            return cjk_font
        print(f"Warning: Text contains non-ASCII characters but no CJK font available", file=sys.stderr)
    return requested_font


def transform_from_image_coords(bbox, image_width, image_height, pdf_width, pdf_height):
    """Transform bounding box from image coordinates to PDF coordinates"""
    x_scale = pdf_width / image_width
    y_scale = pdf_height / image_height

    left = bbox[0] * x_scale
    right = bbox[2] * x_scale
    top = pdf_height - (bbox[1] * y_scale)
    bottom = pdf_height - (bbox[3] * y_scale)

    return left, bottom, right, top


def transform_from_pdf_coords(bbox, pdf_height):
    """Transform bounding box from pdfplumber coordinates to reportlab coordinates.

    pdfplumber uses y=0 at top, y increases downward (like images).
    reportlab uses y=0 at bottom, y increases upward.
    Both use the same scale (PDF points), so only Y needs flipping.
    """
    left = bbox[0]
    right = bbox[2]
    pypdf_top = pdf_height - bbox[1]
    pypdf_bottom = pdf_height - bbox[3]

    return left, pypdf_bottom, right, pypdf_top


def hex_to_rgb(hex_color):
    """Convert hex color string to RGB tuple (0-1 range)"""
    hex_color = hex_color.lstrip('#')
    r = int(hex_color[0:2], 16) / 255.0
    g = int(hex_color[2:4], 16) / 255.0
    b = int(hex_color[4:6], 16) / 255.0
    return (r, g, b)


def draw_text_with_wrap(c, text, box, font_name, font_size, font_color):
    """Draw text with automatic word wrap support for CJK characters"""
    left, bottom, right, top = box
    width = right - left
    height = top - bottom
    
    r, g, b = hex_to_rgb(font_color)
    hex_color_str = '%02x%02x%02x' % (int(r*255), int(g*255), int(b*255))
    
    style = ParagraphStyle(
        'FieldStyle',
        fontName=font_name,
        fontSize=font_size,
        leading=font_size * 1.2,
        textColor=font_color,
        wordWrap='CJK',
    )
    
    para = Paragraph(text, style)
    
    frame = Frame(left, bottom, width, height, leftPadding=0, bottomPadding=0, 
                  rightPadding=0, topPadding=0, showBoundary=0)
    frame.addFromList([para], c)


def create_text_overlay(fields_by_page, pdf_dimensions):
    """Create a PDF with text overlays using reportlab"""
    buffer = io.BytesIO()
    
    first_page_num = min(pdf_dimensions.keys())
    first_width, first_height = pdf_dimensions[first_page_num]
    c = canvas.Canvas(buffer, pagesize=(float(first_width), float(first_height)))
    
    max_page = max(pdf_dimensions.keys())
    
    for page_num in range(1, max_page + 1):
        pdf_width, pdf_height = pdf_dimensions.get(page_num, (612, 792))
        c.setPageSize((float(pdf_width), float(pdf_height)))
        
        if page_num in fields_by_page:
            for field_info in fields_by_page[page_num]:
                text = field_info["text"]
                box = field_info["box"]
                font_name = field_info["font_name"]
                font_size = field_info["font_size"]
                font_color = field_info["font_color"]
                
                actual_font = get_font_for_text(text, font_name)
                
                left, bottom, right, top = box
                box_width = right - left
                
                try:
                    pdfmetrics.getFont(actual_font)
                except KeyError:
                    actual_font = "Helvetica"
                
                text_width = pdfmetrics.stringWidth(text, actual_font, font_size)
                
                if text_width > box_width or '\n' in text:
                    draw_text_with_wrap(c, text, box, actual_font, font_size, font_color)
                else:
                    try:
                        c.setFont(actual_font, font_size)
                    except KeyError:
                        c.setFont("Helvetica", font_size)
                    
                    r, g, b = hex_to_rgb(font_color)
                    c.setFillColorRGB(r, g, b)
                    
                    x = left
                    y = bottom + (top - bottom - font_size) / 2 + font_size * 0.2
                    
                    c.drawString(x, y, text)
        
        c.showPage()
    
    c.save()
    buffer.seek(0)
    return buffer


def fill_pdf_form(input_pdf_path, fields_json_path, output_pdf_path):
    """Fill the PDF form with data from fields.json"""
    
    with open(fields_json_path, "r", encoding="utf-8") as f:
        fields_data = json.load(f)
    
    reader = PdfReader(input_pdf_path)
    
    pdf_dimensions = {}
    for i, page in enumerate(reader.pages):
        mediabox = page.mediabox
        pdf_dimensions[i + 1] = [mediabox.width, mediabox.height]
    
    fields_by_page = {}
    
    for field in fields_data["form_fields"]:
        page_num = field["page_number"]
        page_info = next(p for p in fields_data["pages"] if p["page_number"] == page_num)
        pdf_width, pdf_height = pdf_dimensions[page_num]

        if "pdf_width" in page_info:
            transformed_entry_box = transform_from_pdf_coords(
                field["entry_bounding_box"],
                float(pdf_height)
            )
        else:
            image_width = page_info["image_width"]
            image_height = page_info["image_height"]
            transformed_entry_box = transform_from_image_coords(
                field["entry_bounding_box"],
                image_width, image_height,
                float(pdf_width), float(pdf_height)
            )
        
        if "entry_text" not in field or "text" not in field["entry_text"]:
            continue
        entry_text = field["entry_text"]
        text = entry_text["text"]
        if not text:
            continue
        
        font_name = entry_text.get("font", "Helvetica")
        font_size_str = entry_text.get("font_size", 14)
        if isinstance(font_size_str, str):
            font_size = float(font_size_str.replace("pt", ""))
        else:
            font_size = float(font_size_str)
        font_color = entry_text.get("font_color", "000000")
        
        if page_num not in fields_by_page:
            fields_by_page[page_num] = []
        
        fields_by_page[page_num].append({
            "text": text,
            "box": transformed_entry_box,
            "font_name": font_name,
            "font_size": font_size,
            "font_color": font_color,
        })
    
    overlay_buffer = create_text_overlay(fields_by_page, pdf_dimensions)
    overlay_reader = PdfReader(overlay_buffer)
    
    writer = PdfWriter()
    
    for i, page in enumerate(reader.pages):
        if i < len(overlay_reader.pages):
            overlay_page = overlay_reader.pages[i]
            page.merge_page(overlay_page)
        writer.add_page(page)
    
    with open(output_pdf_path, "wb") as output:
        writer.write(output)
    
    total_fields = sum(len(fields) for fields in fields_by_page.values())
    print(f"Successfully filled PDF form and saved to {output_pdf_path}")
    print(f"Added {total_fields} text fields")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: fill_pdf_form_with_annotations.py [input pdf] [fields.json] [output pdf]")
        sys.exit(1)
    input_pdf = sys.argv[1]
    fields_json = sys.argv[2]
    output_pdf = sys.argv[3]
    
    fill_pdf_form(input_pdf, fields_json, output_pdf)
