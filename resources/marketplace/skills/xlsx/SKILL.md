---
name: xlsx
description: "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like \"the xlsx in my downloads\") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved."
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

# Requirements for Outputs

## All Excel files

### Professional Font
- Use a consistent, professional font (e.g., Arial, Times New Roman) for all deliverables unless otherwise instructed by the user

### Zero Formula Errors
- Every Excel model MUST be delivered with ZERO formula errors (#REF!, #DIV/0!, #VALUE!, #N/A, #NAME?)

### Preserve Existing Templates (when updating templates)
- Study and EXACTLY match existing format, style, and conventions when modifying files
- Never impose standardized formatting on files with established patterns
- Existing template conventions ALWAYS override these guidelines

### Visual Table Design (MUST for new tables unless user/template says otherwise)
- Apply zebra striping in data regions (not headers or totals), using low-contrast alternating fills (for example `#FFFFFF` and `#F7F9FC`)
- Apply thin, light borders for structure (for example `#D9DEE7`), favoring outer border + row separators over heavy full-grid borders
- For subtotal/total emphasis, use hierarchy cues (bold text and/or top border emphasis) instead of thick borders around every cell

### KPI Visual Hierarchy (MUST when KPI-like metrics exist)
- Highlight an appropriate number of key metrics based on content complexity, prioritizing summary rows, current-period critical values, and exceptions
- Keep highlight treatment consistent (prefer bold + light fill) and avoid overusing saturated colors
- Keep color semantics consistent across the workbook (for example green=positive, red=risk)
- Add short labels near highlighted metrics when helpful (for example "Core KPI", "Exception")

## Financial models

### Color Coding Standards
Unless otherwise stated by the user or existing template

#### Industry-Standard Color Conventions
- **Blue text (RGB: 0,0,255)**: Hardcoded inputs, and numbers users will change for scenarios
- **Black text (RGB: 0,0,0)**: ALL formulas and calculations
- **Green text (RGB: 0,128,0)**: Links pulling from other worksheets within same workbook
- **Red text (RGB: 255,0,0)**: External links to other files
- **Yellow background (RGB: 255,255,0)**: Key assumptions needing attention or cells that need to be updated

### Number Formatting Standards

#### Required Format Rules
- **Years**: Format as text strings (e.g., "2024" not "2,024")
- **Currency**: Use $#,##0 format; ALWAYS specify units in headers ("Revenue ($mm)")
- **Zeros**: Use number formatting to make all zeros "-", including percentages (e.g., "$#,##0;($#,##0);-")
- **Percentages**: Default to 0.0% format (one decimal)
- **Multiples**: Format as 0.0x for valuation multiples (EV/EBITDA, P/E)
- **Negative numbers**: Use parentheses (123) not minus -123

### Formula Construction Rules

#### Assumptions Placement
- Place ALL assumptions (growth rates, margins, multiples, etc.) in separate assumption cells
- Use cell references instead of hardcoded values in formulas
- Example: Use =B5*(1+$B$6) instead of =B5*1.05

#### Formula Error Prevention
- Verify all cell references are correct
- Check for off-by-one errors in ranges
- Ensure consistent formulas across all projection periods
- Test with edge cases (zero values, negative numbers)
- Verify no unintended circular references

#### Documentation Requirements for Hardcodes
- Comment or in cells beside (if end of table). Format: "Source: [System/Document], [Date], [Specific Reference], [URL if applicable]"
- Examples:
  - "Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]"
  - "Source: Company 10-Q, Q2 2025, Exhibit 99.1, [SEC EDGAR URL]"
  - "Source: Bloomberg Terminal, 8/15/2025, AAPL US Equity"
  - "Source: FactSet, 8/20/2025, Consensus Estimates Screen"

# XLSX creation, editing, and analysis

## Overview

A user may ask you to create, edit, or analyze the contents of an .xlsx file. You have different tools and workflows available for different tasks.

## Important Requirements

**LibreOffice Required for Formula Recalculation**: You can assume LibreOffice is installed for recalculating formula values using the `scripts/recalc.py` script. The script automatically configures LibreOffice on first run, including in sandboxed environments where IPC restrictions may apply (handled by `scripts/office/soffice.py`)

## Reading and analyzing data

### Data analysis with pandas
For data analysis, visualization, and basic operations, use **pandas** which provides powerful data manipulation capabilities:

```python
import pandas as pd

# Read Excel
df = pd.read_excel('file.xlsx')  # Default: first sheet
all_sheets = pd.read_excel('file.xlsx', sheet_name=None)  # All sheets as dict

# Analyze
df.head()      # Preview data
df.info()      # Column info
df.describe()  # Statistics

# Write Excel
df.to_excel('output.xlsx', index=False)
```

## Excel File Workflows

## CRITICAL: Use Formulas, Not Hardcoded Values

**Always use Excel formulas instead of calculating values in Python and hardcoding them.** This ensures the spreadsheet remains dynamic and updateable.

### ❌ WRONG - Hardcoding Calculated Values
```python
# Bad: Calculating in Python and hardcoding result
total = df['Sales'].sum()
sheet['B10'] = total  # Hardcodes 5000

# Bad: Computing growth rate in Python
growth = (df.iloc[-1]['Revenue'] - df.iloc[0]['Revenue']) / df.iloc[0]['Revenue']
sheet['C5'] = growth  # Hardcodes 0.15

# Bad: Python calculation for average
avg = sum(values) / len(values)
sheet['D20'] = avg  # Hardcodes 42.5
```

### ✅ CORRECT - Using Excel Formulas
```python
# Good: Let Excel calculate the sum
sheet['B10'] = '=SUM(B2:B9)'

# Good: Growth rate as Excel formula
sheet['C5'] = '=(C4-C2)/C2'

# Good: Average using Excel function
sheet['D20'] = '=AVERAGE(D2:D19)'
```

This applies to ALL calculations - totals, percentages, ratios, differences, etc. The spreadsheet should be able to recalculate when source data changes.

## ⚠️ REQUIRED: Pre-Build Planning

**Before writing any data/formulas/code, you MUST complete these planning steps:**

### Step 1: Problem Review
- Read all relevant files (source Excel/CSV/TSV, template workbook, and referenced documents)
- Combine file findings with the user query and restate the task intent in concrete terms

### Step 2: Output Detailed Workbook Plan
Present a structured plan covering:

1. **Sheet Plan**
   - Total number of sheets
   - Each sheet name
   - Purpose of each sheet

2. **Schema Plan (per sheet)**
   - Row fields (if row-oriented)
   - Column fields (if column-oriented)
   - Value source/calculation for each field (raw source / lookup / formula / aggregation)

3. **Style Plan (per sheet)**
   - Header style (fill, font color, emphasis)
   - Zebra striping design
   - KPI visual hierarchy design

**Required planning output format:**
```markdown
## Problem Review
- Files read: ...
- Task understanding: ...

## Detailed Plan
### Sheet Plan
1. Sheet: <name> — Purpose: <purpose>

### Schema Plan
1. Sheet: <name>
- Row fields: ...
- Column fields: ...
- Value source/calculation: ...

### Style Plan
1. Sheet: <name>
- Header: ...
- Zebra striping: ...
- KPI hierarchy: ...
```

If inputs are incomplete, still output this plan with explicit assumptions first.

**Only proceed to implementation after:**
- [ ] Problem Review is complete
- [ ] Detailed Workbook Plan is output

## Common Workflow
1. **Output plan first (MANDATORY)**: Output Problem Review + Detailed Plan using the required format above
2. **Choose tool**: pandas for data, openpyxl for formulas/formatting
3. **Create/Load**: Create new workbook or load existing file
4. **Modify**: Add/edit data, formulas, and formatting
5. **Save**: Write to file
6. **Recalculate formulas (MANDATORY IF USING FORMULAS)**: Use the scripts/recalc.py script
   ```bash
   python scripts/recalc.py output.xlsx
   ```
7. **Verify and fix any errors**: 
   - The script returns JSON with error details
   - If `status` is `errors_found`, check `error_summary` for specific error types and locations
   - Fix the identified errors and recalculate again
   - Common errors to fix:
     - `#REF!`: Invalid cell references
     - `#DIV/0!`: Division by zero
     - `#VALUE!`: Wrong data type in formula
     - `#NAME?`: Unrecognized formula name

### Creating new Excel files

```python
# Using openpyxl for formulas and formatting
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

wb = Workbook()
sheet = wb.active

# Add data
sheet['A1'] = 'Hello'
sheet['B1'] = 'World'
sheet.append(['Row', 'of', 'data'])

# Add formula
sheet['B2'] = '=SUM(A1:A10)'

# Formatting
sheet['A1'].font = Font(bold=True, color='FF0000')
sheet['A1'].fill = PatternFill('solid', start_color='FFFF00')
sheet['A1'].alignment = Alignment(horizontal='center')

# Column width
sheet.column_dimensions['A'].width = 20

wb.save('output.xlsx')
```

### Editing existing Excel files

```python
# Using openpyxl to preserve formulas and formatting
from openpyxl import load_workbook

# Load existing file
wb = load_workbook('existing.xlsx')
sheet = wb.active  # or wb['SheetName'] for specific sheet

# Working with multiple sheets
for sheet_name in wb.sheetnames:
    sheet = wb[sheet_name]
    print(f"Sheet: {sheet_name}")

# Modify cells
sheet['A1'] = 'New Value'
sheet.insert_rows(2)  # Insert row at position 2
sheet.delete_cols(3)  # Delete column 3

# Add new sheet
new_sheet = wb.create_sheet('NewSheet')
new_sheet['A1'] = 'Data'

wb.save('modified.xlsx')
```

## Recalculating formulas

Excel files created or modified by openpyxl contain formulas as strings but not calculated values. Use the provided `scripts/recalc.py` script to recalculate formulas:

```bash
python scripts/recalc.py <excel_file> [timeout_seconds]
```

Example:
```bash
python scripts/recalc.py output.xlsx 30
```

The script:
- Automatically sets up LibreOffice macro on first run
- Recalculates all formulas in all sheets
- Scans ALL cells for Excel errors (#REF!, #DIV/0!, etc.)
- Returns JSON with detailed error locations and counts
- Works on Linux, macOS, and Windows

## Formula Verification Checklist

Quick checks to ensure formulas work correctly:

### Essential Verification
- [ ] **Test 2-3 sample references**: Verify they pull correct values before building full model
- [ ] **Column mapping**: Confirm Excel columns match (e.g., column 64 = BL, not BK)
- [ ] **Row offset**: Remember Excel rows are 1-indexed (DataFrame row 5 = Excel row 6)

### Common Pitfalls
- [ ] **NaN handling**: Check for null values with `pd.notna()`
- [ ] **Far-right columns**: FY data often in columns 50+ 
- [ ] **Multiple matches**: Search all occurrences, not just first
- [ ] **Division by zero**: Check denominators before using `/` in formulas (#DIV/0!)
- [ ] **Wrong references**: Verify all cell references point to intended cells (#REF!)
- [ ] **Cross-sheet references**: Use correct format (Sheet1!A1) for linking sheets

### Formula Testing Strategy
- [ ] **Start small**: Test formulas on 2-3 cells before applying broadly
- [ ] **Verify dependencies**: Check all cells referenced in formulas exist
- [ ] **Test edge cases**: Include zero, negative, and very large values

### Interpreting scripts/recalc.py Output
The script returns JSON with error details:
```json
{
  "status": "success",           // or "errors_found"
  "total_errors": 0,              // Total error count
  "total_formulas": 42,           // Number of formulas in file
  "error_summary": {              // Only present if errors found
    "#REF!": {
      "count": 2,
      "locations": ["Sheet1!B5", "Sheet1!C10"]
    }
  }
}
```

## Best Practices

### Library Selection
- **pandas**: Best for data analysis, bulk operations, and simple data export
- **openpyxl**: Best for complex formatting, formulas, and Excel-specific features

### Working with openpyxl
- Cell indices are 1-based (row=1, column=1 refers to cell A1)
- Use `data_only=True` to read calculated values: `load_workbook('file.xlsx', data_only=True)`
- **Warning**: If opened with `data_only=True` and saved, formulas are replaced with values and permanently lost
- For large files: Use `read_only=True` for reading or `write_only=True` for writing
- Formulas are preserved but not evaluated - use scripts/recalc.py to update values

### Working with pandas
- Specify data types to avoid inference issues: `pd.read_excel('file.xlsx', dtype={'id': str})`
- For large files, read specific columns: `pd.read_excel('file.xlsx', usecols=['A', 'C', 'E'])`
- Handle dates properly: `pd.read_excel('file.xlsx', parse_dates=['date_column'])`

### Reusable Styling Helpers (openpyxl)
Use helper functions so visual rules are applied consistently instead of ad-hoc cell formatting:

```python
from openpyxl.styles import PatternFill, Border, Side, Font

ZEBRA_FILL_1 = PatternFill(fill_type="solid", fgColor="FFFFFF")
ZEBRA_FILL_2 = PatternFill(fill_type="solid", fgColor="F7F9FC")
KPI_FILL = PatternFill(fill_type="solid", fgColor="EAF2FF")
THIN_BORDER = Border(
    left=Side(style="thin", color="D9DEE7"),
    right=Side(style="thin", color="D9DEE7"),
    top=Side(style="thin", color="D9DEE7"),
    bottom=Side(style="thin", color="D9DEE7"),
)
TOP_EMPHASIS_BORDER = Border(
    left=Side(style="thin", color="D9DEE7"),
    right=Side(style="thin", color="D9DEE7"),
    top=Side(style="medium", color="AAB4C5"),
    bottom=Side(style="thin", color="D9DEE7"),
)

def apply_zebra_style(ws, min_row, max_row, min_col, max_col):
    for r in range(min_row, max_row + 1):
        fill = ZEBRA_FILL_1 if (r - min_row) % 2 == 0 else ZEBRA_FILL_2
        for c in range(min_col, max_col + 1):
            ws.cell(r, c).fill = fill

def apply_light_borders(ws, min_row, max_row, min_col, max_col):
    for r in range(min_row, max_row + 1):
        for c in range(min_col, max_col + 1):
            ws.cell(r, c).border = THIN_BORDER

def highlight_kpis(ws, cells, label_col=None, label_text=None):
    # cells example: ["F5", "F12", "F20"]
    for ref in cells:
        cell = ws[ref]
        cell.fill = KPI_FILL
        cell.font = Font(bold=True, color="1F2937")
    if label_col and label_text and cells:
        ws[f"{label_col}{ws[cells[0]].row}"] = label_text

# Example usage:
# apply_zebra_style(ws, min_row=2, max_row=30, min_col=1, max_col=8)
# apply_light_borders(ws, min_row=1, max_row=30, min_col=1, max_col=8)
# highlight_kpis(ws, cells=["F5", "F12"], label_col="G", label_text="Core KPI")
# ws["A31"].border = TOP_EMPHASIS_BORDER  # subtotal/total row emphasis
```

## Code Style Guidelines
**IMPORTANT**: When generating Python code for Excel operations:
- Write minimal, concise Python code without unnecessary comments
- Avoid verbose variable names and redundant operations
- Avoid unnecessary print statements

**For Excel files themselves**:
- Add comments to cells with complex formulas or important assumptions
- Document data sources for hardcoded values
- Include notes for key calculations and model sections
