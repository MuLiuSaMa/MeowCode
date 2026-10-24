---
name: pdf
description: Comprehensive PDF manipulation toolkit for extracting text and tables, creating new PDFs, merging/splitting documents, and handling forms. When you need to fill in a PDF form or programmatically process, generate, or analyze PDF documents at scale.
license: Proprietary. LICENSE.txt has complete terms
supported_os:
  - windows
---

## Step-by-step execution and dependencies

1. Follow this Skill's workflow in order. Before a step uses a library, command-line tool, runtime, or font, check only the dependencies required by that step; do not assume they are installed.
2. Reuse dependencies that are available. If one is missing, install only that dependency using the current OS and an available package manager, then verify it and retry the original step. Do not install the entire dependency list in advance.
3. Use the active Python environment (`python -m pip install <package>`, or the matching `python3`); create a task-local virtual environment if needed. Install Node.js libraries in the task project (`npm install <package>`) so the script can resolve them. For system tools and fonts, use the available OS package manager (for example, Homebrew on macOS, apt on Debian/Ubuntu, or winget on Windows).
4. Follow the host's permission flow when installation needs approval. If the package manager or required permission is unavailable, or installation/download fails, report the missing dependency and affected step; do not retry indefinitely or claim the step passed. Continue independent steps when possible.
5. Keep the original workflow and quality checks. Check fonts only when rendering requires them. Steps using only text, built-in tools, or self-contained HTML require no package installation; external tool access or authentication must be handled through the host, not a package manager.

# PDF Processing Guide

## Overview

This guide covers essential PDF processing operations using Python libraries and command-line tools. For advanced features, JavaScript libraries, and detailed examples, see REFERENCE.md. If you need to fill out a PDF form, read FORMS.md and follow its instructions.

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

# Read a PDF
reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

# Extract text
text = ""
for page in reader.pages:
    text += page.extract_text()
```

## Long PDF Workflow

When PDF files are long, do not rely on a single full-text output. Extract per-page files first, then search with keywords or regex.
`extract_pages.py` removes `(cid:123)`-style garbage tokens during extraction to reduce context waste.
It also repairs missing spaces for English text by falling back to word-level extraction when long merged tokens are detected.

### Multi-Query Search Workflow

> **Windows:** `bash` is not available on Windows. Replace `bash scripts/search_extracted.sh` with `python scripts/search_extracted.py` in all commands below. The arguments are identical.

If you have multiple queries to search, **NEVER call `search_extracted.sh` multiple times with individual queries**. Instead:
1. Write all queries to a text file (one query per line)
2. Use `--query-file` to search all queries at once
3. The script will automatically deduplicate pages across all queries

```bash
# Create queries.txt with one query per line
echo "find methodology" > queries.txt
echo "find results" >> queries.txt
echo "find conclusion" >> queries.txt

# Search all queries at once with deduplication
bash scripts/search_extracted.sh extracted --query-file queries.txt
```

### Mandatory Retrieval Rule

For task-oriented processing (for example, preparing PPT materials), always use query-based retrieval from extracted files.

- MUST: extract to `pages/page_XXXX.txt`
- MUST: build a task-level long query from user intent and key constraints
- MUST: run `search_extracted.sh` and use matched files as evidence
- MUST: use full matched page as context for page hits
- MUST: include previous page when hit is within the first 5 lines
- MUST: include next page when hit is within the last 5 lines
- MUST: deduplicate already included context pages
- MUST NOT: read fixed page ranges such as the first 20 pages by default
- MUST NOT: concatenate large page ranges into one long context

```bash
# 1) Extract one text file per page
python3 scripts/extract_pages.py input.pdf extracted

# Output:
# extracted/pages/page_0001.txt
# extracted/pages/page_0002.txt
# ...

# 2) Task-level long query search (phrase extraction + recall/rerank)
bash scripts/search_extracted.sh extracted "find methodology and experimental setup for ReAct with action-observation loop and reasoning traces"

# 3) Regex search
bash scripts/search_extracted.sh extracted "ReAct|reasoning|agent" --regex

# 4) Multi-query search with cross-query page dedup
# queries.txt contains one query per line
bash scripts/search_extracted.sh extracted --query-file queries.txt
```

### End-to-End Example

```bash
# Goal: find evidence for "method + metrics" from a long PDF

python3 scripts/extract_pages.py report.pdf extracted

# Find methodology-related evidence
bash scripts/search_extracted.sh extracted "find method section describing interleaved reasoning and acting with concrete procedure details"

# Find numeric evidence from page text
bash scripts/search_extracted.sh extracted "[0-9]{4}|[0-9]+%" --regex
```

For page files, each hit returns the whole page as context. If the hit is near page boundaries (first 5 lines or last 5 lines), neighboring pages are also included once.
For long queries, the search script automatically extracts phrases and keywords, computes IDF-weighted recall/reranking, and keeps top 3 matched pages before context expansion.
When `--query-file` is used, matched pages are deduplicated across all queries before final output.
Use matched file paths (for example, `pages/page_0031.txt`) as direct evidence inputs for downstream tasks.

### Fallback Strategy
If `search_extracted.sh` returns "No matches found", you should fall back to reading all extracted page files directly. Iterate through `pages/page_XXXX.txt` in order and read each page's content as context.

### Anti-Pattern (Do Not Use)

```python
# Bad: fixed-range reading causes irrelevant context and misses key evidence
with pdfplumber.open("document.pdf") as pdf:
    full_text = ""
    for page in pdf.pages[:20]:
        full_text += page.extract_text() or ""
```

Always prefer extract-to-files + grep retrieval over fixed-range full reads.

## Python Libraries

### pypdf - Basic Operations

#### Merge PDFs
```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
```

#### Split PDF
```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

#### Extract Metadata
```python
reader = PdfReader("document.pdf")
meta = reader.metadata
print(f"Title: {meta.title}")
print(f"Author: {meta.author}")
print(f"Subject: {meta.subject}")
print(f"Creator: {meta.creator}")
```

#### Rotate Pages
```python
reader = PdfReader("input.pdf")
writer = PdfWriter()

page = reader.pages[0]
page.rotate(90)  # Rotate 90 degrees clockwise
writer.add_page(page)

with open("rotated.pdf", "wb") as output:
    writer.write(output)
```

### pdfplumber - Text and Table Extraction

#### Extract Text with Layout
```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
```

#### Extract Tables
```python
with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        tables = page.extract_tables()
        for j, table in enumerate(tables):
            print(f"Table {j+1} on page {i+1}:")
            for row in table:
                print(row)
```

#### Advanced Table Extraction
```python
import pandas as pd

with pdfplumber.open("document.pdf") as pdf:
    all_tables = []
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            if table:  # Check if table is not empty
                df = pd.DataFrame(table[1:], columns=table[0])
                all_tables.append(df)

# Combine all tables
if all_tables:
    combined_df = pd.concat(all_tables, ignore_index=True)
    combined_df.to_excel("extracted_tables.xlsx", index=False)
```

### reportlab - Create PDFs

#### CJK Font Support (Chinese/Japanese/Korean)

When creating PDFs with non-ASCII text (e.g., Chinese, Japanese, Korean), you MUST register a CJK-capable font first:

```python
import os
import platform
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

def register_cjk_font():
    """Register a CJK-capable font based on the operating system"""
    system = platform.system()

    if system == "Darwin":  # macOS
        font_paths = [
            "/System/Library/Fonts/PingFang.ttc",
            "/Library/Fonts/Arial Unicode.ttf",
            "/System/Library/Fonts/STHeiti Medium.ttc",
        ]
    elif system == "Windows":
        font_paths = [
            "C:/Windows/Fonts/msyh.ttc",  # Microsoft YaHei
            "C:/Windows/Fonts/simsun.ttc",  # SimSun
        ]
    else:  # Linux
        font_paths = [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        ]

    for font_path in font_paths:
        if os.path.exists(font_path):
            pdfmetrics.registerFont(TTFont("CJKFont", font_path, subfontIndex=0))
            return "CJKFont"
    return None

# Register CJK font before creating PDF
cjk_font = register_cjk_font()
```

#### Professional Styles (MUST USE)

Always use these well-designed styles for professional-looking PDFs:

```python
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor

PRIMARY_COLOR = HexColor('#1a365d')
ACCENT_COLOR = HexColor('#2b6cb0')

def get_professional_styles(cjk_font='CJKFont'):
    """Return a dict of professional styles for PDF generation"""
    return {
        'title': ParagraphStyle(
            'Title', fontName=cjk_font, fontSize=28, leading=34,
            textColor=PRIMARY_COLOR, spaceAfter=20, alignment=1, wordWrap='CJK'
        ),
        'subtitle': ParagraphStyle(
            'Subtitle', fontName=cjk_font, fontSize=14, leading=18,
            textColor=HexColor('#4a5568'), spaceAfter=30, alignment=1, wordWrap='CJK'
        ),
        'h1': ParagraphStyle(
            'H1', fontName=cjk_font, fontSize=20, leading=26,
            textColor=PRIMARY_COLOR, spaceBefore=24, spaceAfter=12, wordWrap='CJK'
        ),
        'h2': ParagraphStyle(
            'H2', fontName=cjk_font, fontSize=16, leading=22,
            textColor=ACCENT_COLOR, spaceBefore=18, spaceAfter=8, wordWrap='CJK'
        ),
        'body': ParagraphStyle(
            'Body', fontName=cjk_font, fontSize=11, leading=18,
            textColor=HexColor('#2d3748'), spaceBefore=0, spaceAfter=10,
            firstLineIndent=0, wordWrap='CJK'
        ),
        'caption': ParagraphStyle(
            'Caption', fontName=cjk_font, fontSize=9, leading=12,
            textColor=HexColor('#718096'), alignment=1, spaceBefore=6, spaceAfter=12, wordWrap='CJK'
        ),
    }

# Usage
styles = get_professional_styles('CJKFont')
story.append(Paragraph("标题 Title", styles['title']))
story.append(Paragraph("第一章 Chapter 1", styles['h1']))
story.append(Paragraph("正文内容...", styles['body']))
```

#### Professional Table Styles

```python
from reportlab.lib.colors import HexColor
from reportlab.platypus import Table, LongTable
from reportlab.lib import colors

def create_styled_table(data, col_widths=None, is_large=False):
    """Create a professionally styled table"""
    TableClass = LongTable if is_large else Table
    table = TableClass(data, colWidths=col_widths, repeatRows=1 if is_large else 0)

    table.setStyle([
        ('BACKGROUND', (0, 0), (-1, 0), HexColor('#2b6cb0')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, -1), 'CJKFont'),
        ('FONTSIZE', (0, 0), (-1, 0), 11),
        ('FONTSIZE', (0, 1), (-1, -1), 10),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 10),
        ('TOPPADDING', (0, 0), (-1, 0), 10),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 8),
        ('TOPPADDING', (0, 1), (-1, -1), 8),
        ('BACKGROUND', (0, 1), (-1, -1), HexColor('#f7fafc')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [HexColor('#f7fafc'), colors.white]),
        ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#e2e8f0')),
    ])
    return table
```

#### Inline Text Formatting

Use HTML-like tags inside Paragraph for rich text:

```python
from reportlab.platypus import Paragraph

text = """
<b>粗体 Bold</b>, <i>斜体 Italic</i>, <u>下划线 Underline</u>
<font color="#2b6cb0">蓝色文字 Blue text</font>
<font size="14">大字号 Larger</font>, <font size="9">小字号 Smaller</font>
化学式: H<sub>2</sub>O, 数学: E=mc<sup>2</sup>
<br/>换行 Line break
"""
story.append(Paragraph(text, styles['body']))
```

| Tag | Effect |
|-----|--------|
| `<b>` | **粗体** |
| `<i>` | *斜体* |
| `<u>` | 下划线 |
| `<font color="...">` | 颜色 |
| `<font size="...">` | 字号 |
| `<sub>` | 下标 |
| `<sup>` | 上标 |
| `<br/>` | 换行 |

#### Text Alignment

```python
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY
from reportlab.lib.styles import ParagraphStyle

left_style = ParagraphStyle('Left', alignment=TA_LEFT)
center_style = ParagraphStyle('Center', alignment=TA_CENTER)
right_style = ParagraphStyle('Right', alignment=TA_RIGHT)
justify_style = ParagraphStyle('Justify', alignment=TA_JUSTIFY)
```

#### Colored Divider Lines

Add decorative divider lines under titles and headings for visual hierarchy:

```python
from reportlab.platypus import Flowable
from reportlab.lib.colors import HexColor
from reportlab.lib.units import inch

class ColoredDivider(Flowable):
    """A colored horizontal divider line"""
    def __init__(self, width, height=2, color=HexColor('#2b6cb0'), space_before=6, space_after=12):
        Flowable.__init__(self)
        self.width = width
        self.height = height
        self.color = color
        self.spaceAfter = space_after
        self.spaceBefore = space_before

    def draw(self):
        self.canv.setFillColor(self.color)
        self.canv.rect(0, 0, self.width, self.height, fill=1, stroke=0)

# Pre-defined dividers
CONTENT_WIDTH = 6.5 * inch

def title_divider():
    """Wide accent divider for document title"""
    return ColoredDivider(CONTENT_WIDTH, height=3, color=HexColor('#2b6cb0'), space_after=20)

def h1_divider():
    """Medium divider for H1 headings"""
    return ColoredDivider(CONTENT_WIDTH * 0.3, height=2, color=HexColor('#2b6cb0'), space_after=12)

def subtle_divider():
    """Thin gray divider for sections"""
    return ColoredDivider(CONTENT_WIDTH, height=1, color=HexColor('#e2e8f0'), space_after=10)

# Usage in story
story.append(Paragraph("报告标题 Report Title", styles['title']))
story.append(title_divider())  # Accent line under title

story.append(Paragraph("第一章 Chapter 1", styles['h1']))
story.append(h1_divider())  # Short accent line under H1

story.append(Paragraph("正文内容...", styles['body']))
story.append(subtle_divider())  # Subtle section separator
```

#### Document Setup with Proper Margins

```python
from reportlab.lib.pagesizes import letter, A4
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate

doc = SimpleDocTemplate(
    "report.pdf",
    pagesize=letter,
    leftMargin=0.75*inch,
    rightMargin=0.75*inch,
    topMargin=0.75*inch,
    bottomMargin=0.75*inch,
)
```

#### Pagination Best Practices (IMPORTANT)

**Core Principle**: Let content flow naturally. Minimize `PageBreak` and `KeepTogether` usage.

| Content | How to Add | KeepTogether? | PageBreak? |
|---------|-----------|---------------|------------|
| Cover page | `story.append()` + `PageBreak()` after | No | **Only after cover** |
| **Headings** | `story.append()` directly | **NO** | **NO** |
| **Paragraphs** | `story.append()` directly | **NO** | **NO** |
| Images + captions | `KeepTogether([Image, Paragraph])` | Yes | No |
| Small tables | `KeepTogether([Table])` | Yes | No |
| Large tables | `LongTable(..., repeatRows=1)` | No | No |

**⚠️ COMMON MISTAKE #1 - Too many PageBreaks:**
```python
# WRONG: Do NOT add PageBreak before chapters/sections!
story.append(PageBreak())  # Creates wasted blank space!
story.append(Paragraph("Chapter 2", heading_style))

# CORRECT: Just add heading directly, content flows naturally
story.append(Paragraph("Chapter 2", heading_style))
```
**Rule: Use PageBreak ONLY once after cover page. Never use PageBreak anywhere else!**

**⚠️ COMMON MISTAKE #2 - KeepTogether on headings/paragraphs:**
```python
# WRONG: Creates half-page blank spaces!
story.append(KeepTogether([
    Paragraph("Chapter 2", heading_style),
    Paragraph("Long content...", body_style),
]))

# CORRECT: Add directly, let content flow and split naturally
story.append(Paragraph("Chapter 2", heading_style))
story.append(Paragraph("Long content...", body_style))
```

**Complete Example:**
```python
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, PageBreak, KeepTogether

# 1. Register CJK font first (use register_cjk_font() from above)
register_cjk_font()

# 2. Setup document with proper margins
doc = SimpleDocTemplate("report.pdf", pagesize=letter,
    leftMargin=0.75*inch, rightMargin=0.75*inch,
    topMargin=0.75*inch, bottomMargin=0.75*inch)

# 3. Use professional styles (use get_professional_styles() from above)
styles = get_professional_styles('CJKFont')

story = []

# Cover - use PageBreak ONLY here
story.append(Spacer(1, 2*inch))
story.append(Paragraph("报告标题 Report Title", styles['title']))
story.append(Paragraph("副标题 Subtitle", styles['subtitle']))
story.append(PageBreak())

# Headings & Paragraphs - add directly (NO KeepTogether, NO PageBreak)
story.append(Paragraph("第一章 Introduction", styles['h1']))
story.append(Paragraph("正文内容自然流动，可跨页分割...", styles['body']))
story.append(Paragraph("1.1 背景 Background", styles['h2']))
story.append(Paragraph("更多内容...", styles['body']))

# Images - use KeepTogether
story.append(KeepTogether([
    Image("fig.png", width=400, height=300),
    Paragraph("图 1: 说明文字", styles['caption'])
]))

# Tables - use create_styled_table() from above
story.append(KeepTogether([create_styled_table(small_data)]))

doc.build(story)
```

### matplotlib - Charts with CJK Support

When creating charts/graphs with matplotlib that include Chinese text, you MUST configure the font:

```python
import os
import platform
import matplotlib.pyplot as plt
import matplotlib

def setup_matplotlib_cjk():
    """Configure matplotlib to support CJK characters"""
    system = platform.system()

    if system == "Darwin":  # macOS
        font_names = ['Arial Unicode MS', 'PingFang SC', 'Heiti SC', 'STHeiti']
    elif system == "Windows":
        font_names = ['Microsoft YaHei', 'SimHei', 'SimSun']
    else:  # Linux
        font_names = ['Noto Sans CJK SC', 'WenQuanYi Zen Hei', 'Droid Sans Fallback']

    # Find available font
    available_fonts = [f.name for f in matplotlib.font_manager.fontManager.ttflist]
    for font_name in font_names:
        if font_name in available_fonts:
            plt.rcParams['font.sans-serif'] = [font_name] + plt.rcParams['font.sans-serif']
            plt.rcParams['axes.unicode_minus'] = False  # Fix minus sign display
            return font_name
    return None

# Setup CJK font before creating charts
cjk_font = setup_matplotlib_cjk()

# Create a bar chart with Chinese labels
categories = ['第一季度', '第二季度', '第三季度', '第四季度']
values = [120, 135, 142, 158]

plt.figure(figsize=(10, 6))
plt.bar(categories, values, color='steelblue')
plt.title('季度销售数据 Quarterly Sales', fontsize=16)
plt.xlabel('季度 Quarter', fontsize=12)
plt.ylabel('销售额 Sales', fontsize=12)
plt.tight_layout()
plt.savefig('chart.png', dpi=150)
plt.close()
```

#### Embed matplotlib Chart in PDF
```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Image, Paragraph, Spacer
from reportlab.lib.styles import ParagraphStyle

# First create and save the chart (see above)
# Then embed it in PDF

doc = SimpleDocTemplate("report_with_chart.pdf", pagesize=letter)
story = []

# Add title
cjk_style = ParagraphStyle('CJKStyle', fontName='CJKFont', fontSize=14, wordWrap='CJK')
story.append(Paragraph("销售报告 Sales Report", cjk_style))
story.append(Spacer(1, 20))

# Add the chart image
chart_img = Image('chart.png', width=400, height=240)
story.append(chart_img)
story.append(Spacer(1, 20))

# Add description
story.append(Paragraph("图表显示了四个季度的销售数据变化趋势。", cjk_style))

doc.build(story)
```

## Command-Line Tools

### pdftotext (poppler-utils)
```bash
# Extract text
pdftotext input.pdf output.txt

# Extract text preserving layout
pdftotext -layout input.pdf output.txt

# Extract specific pages
pdftotext -f 1 -l 5 input.pdf output.txt  # Pages 1-5
```

### qpdf
```bash
# Merge PDFs
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split pages
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf
qpdf input.pdf --pages . 6-10 -- pages6-10.pdf

# Rotate pages
qpdf input.pdf output.pdf --rotate=+90:1  # Rotate page 1 by 90 degrees

# Remove password
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
```

### pdftk (if available)
```bash
# Merge
pdftk file1.pdf file2.pdf cat output merged.pdf

# Split
pdftk input.pdf burst

# Rotate
pdftk input.pdf rotate 1east output rotated.pdf
```

## Common Tasks

### Extract Text from Scanned PDFs
```python
# Requires: pip install pytesseract pdf2image
import pytesseract
from pdf2image import convert_from_path

# Convert PDF to images
images = convert_from_path('scanned.pdf')

# OCR each page
text = ""
for i, image in enumerate(images):
    text += f"Page {i+1}:\n"
    text += pytesseract.image_to_string(image)
    text += "\n\n"

print(text)
```

### Add Watermark
```python
from pypdf import PdfReader, PdfWriter

# Create watermark (or load existing)
watermark = PdfReader("watermark.pdf").pages[0]

# Apply to all pages
reader = PdfReader("document.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

with open("watermarked.pdf", "wb") as output:
    writer.write(output)
```

### Extract Images
```bash
# Using pdfimages (poppler-utils)
pdfimages -j input.pdf output_prefix

# This extracts all images as output_prefix-000.jpg, output_prefix-001.jpg, etc.
```

### Password Protection
```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    writer.add_page(page)

# Add password
writer.encrypt("userpassword", "ownerpassword")

with open("encrypted.pdf", "wb") as output:
    writer.write(output)
```

## Quick Reference

| Task | Best Tool | Command/Code |
|------|-----------|--------------|
| Merge PDFs | pypdf | `writer.add_page(page)` |
| Split PDFs | pypdf | One page per file |
| Extract text | pdfplumber | `page.extract_text()` |
| Extract tables | pdfplumber | `page.extract_tables()` |
| Extract long PDF pages | `scripts/extract_pages.py` | `python3 scripts/extract_pages.py input.pdf extracted` |
| Search extracted files | `scripts/search_extracted.sh` (Windows: `scripts/search_extracted.py`) | `bash scripts/search_extracted.sh extracted "long query" [--regex]` |
| Create PDFs | reportlab | Canvas or Platypus |
| Command line merge | qpdf | `qpdf --empty --pages ...` |
| OCR scanned PDFs | pytesseract | Convert to image first |
| Fill PDF forms | pdf-lib or pypdf (see FORMS.md) | See FORMS.md |

## Next Steps

- For advanced pypdfium2 usage, see REFERENCE.md
- For JavaScript libraries (pdf-lib), see REFERENCE.md
- If you need to fill out a PDF form, follow the instructions in FORMS.md
- For troubleshooting guides, see REFERENCE.md
