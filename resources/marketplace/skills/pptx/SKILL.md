---
name: pptx
description: "Presentation creation, editing, and analysis. When you need to work with presentations (.pptx files) for: (1) Creating new presentations, (2) Modifying or editing content, (3) Working with layouts, (4) Adding comments or speaker notes, or any other presentation tasks"
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

# PPTX Skill

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | `python3 -m markitdown presentation.pptx` |
| Edit or create from template | Read [editing.md](editing.md) — QA: `validate_layout.py` + `markitdown` |
| Create from scratch | 1. Plan content → 2. Pre-generate assets → 3. Read [pptxgenjs.md](pptxgenjs.md) |
| Prevent overflow by design | Read [pptxgenjs.md](pptxgenjs.md#layout-safety-prevent-overflow-before-qa) |
| Generate design system | `python3 skills/pptx/scripts/design/search.py "<topic>" --design-system` |
| **Post-generation fix** | `python3 scripts/fix_pptx.py output.pptx` |
| **Layout QA (critical first)** | `python3 scripts/validate_layout.py presentation.pptx` |

---

## Reading Content

```bash
# Text extraction
python3 -m markitdown presentation.pptx

# Raw XML
python3 scripts/unpack.py presentation.pptx unpacked/
```

---

## Editing Workflow

**Read [editing.md](editing.md) for full details.**

1. Analyze template with `markitdown`
2. Unpack + style-layer check + Theme & Style alignment plan
3. Manipulate slides → edit content → clean → pack
4. **⚠️ Layout QA (mandatory gate)**: `python3 scripts/validate_layout.py output.pptx --slides <edited_slide_numbers>`
5. **⚠️ Content QA (mandatory)**: `python3 -m markitdown output.pptx`

---

## Creating from Scratch

**Read [pptxgenjs.md](pptxgenjs.md) for full details.**

Use when no template or reference presentation is available.

**Required Slide Structure (From-Scratch Only)**

When creating a presentation from scratch, you MUST follow this structure:

1. Slide 1: Cover page
2. Slide 2: Table of contents (agenda)
3. Slide 3 onward: Content sections in the exact order listed on Slide 2
4. Final slide: Closing/thank-you page

Do not skip the table of contents slide. Do not place content slides before the table of contents.

**⚠️ No Blank Slides Allowed**

Every slide MUST contain at least one visible element (`addText`, `addShape`, `addImage`, `addChart`, or `addTable`) inside the slide. A slide with only a background color and no content elements is a generation defect.

Common causes of blank slides:
- Forgetting to add content to section divider / transition slides
- Token truncation mid-generation leaving some slides empty
- Assuming slide layout or master will auto-fill content (they won't — pptxgenjs creates minimal layouts with no inherited shapes)

If you intend a slide as a section divider, you MUST explicitly add elements — e.g., a large section number, title text, and/or decorative shapes.

---

## ⚠️ REQUIRED: Pre-Generation Planning

**Before writing any code, you MUST complete these planning steps:**

### Step 1: Output Content Design Plan

Present a structured plan covering:

1. **Overall Theme & Style**
   - Color palette choice (reference "Design Ideas" section)
   - Typography pairing
   - Visual motif to carry across slides

2. **Slide-by-Slide Outline**
   ```
   Slide 1: Cover - Layout type, key elements
   Slide 2: Table of contents - Ordered section list
   Slide 3: [Section 1 from TOC] - Layout type, key elements, insight plan (if visual)
   ...
   Slide N: Closing / Thank You - Layout type, key elements
   ...
   ```

3. **Visual Elements Inventory**
   - List all images, icons, charts, and diagrams needed
   - Mark each as: `[Built-in]` (pptxgenjs shapes/charts) or `[External]` (needs pre-generation)

**Example planning output:**
```markdown
## Presentation Plan

**Theme:** Ocean Gradient palette (065A82, 1C7293, 21295C)
**Fonts:** Georgia (headings) + Calibri (body)
**Motif:** Rounded cards with left accent border

### Slides:
1. Cover Slide - Centered title, gradient background
2. Table of Contents - Overview / Architecture / Metrics / Timeline
3. [Section 1 from TOC] - Layout type, key elements, insight plan (if visual)
...
n. Thank You - Closing statement + contact
```

### Step 2: Pre-Generate External Assets

For figures marked `[External]`, generate them BEFORE writing pptxgenjs code.

**⚠️ CRITICAL: Color Consistency**

All generated diagrams and charts MUST use the same color palette as the presentation. Define colors at the top of your generation script based on your chosen theme.

**Option A: Native Shapes/Charts First (REQUIRED default)**

ALL architecture diagrams, flowcharts, process diagrams, org charts, and relationship diagrams MUST be built with pptxgenjs native shapes (RECTANGLE, OVAL, LINE, connectors + addText). See pptxgenjs.md "Building Diagrams with Native Shapes" for patterns and examples.

- Use a strong template slide (process, comparison, 2-column, icon grid) when it fits
- Use pptxgenjs native shapes (boxes/arrows/lines + text) for flows, architectures, and hierarchies
- Use pptxgenjs charts for simple data charts (bar, pie, line, etc.)

Only fall back to matplotlib for complex statistical charts (heatmaps, scatter plots, box plots) that pptxgenjs charts cannot handle.
Only fall back to Mermaid when the diagram is too complex for native shapes AND involves many cross-links.

**Option B: Matplotlib/Python Charts**

Define color palette at the start to match your PPT theme:

```python
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors

# ============================================================
# COLOR PALETTE - Match your PPT theme
# ============================================================
# Example: "Ocean Gradient" theme
COLORS = {
    'primary': '#065A82',
    'secondary': '#1C7293',
    'accent': '#21295C',
    'background': '#F0F7FA',
    'text': '#21295C',
    'light': '#E8F4F8',
}

# Color cycle for multiple data series
COLOR_CYCLE = [COLORS['primary'], COLORS['secondary'], COLORS['accent'], '#4A90A4', '#2D5A6B']

# Apply theme globally
plt.rcParams.update({
    'axes.prop_cycle': plt.cycler(color=COLOR_CYCLE),
    'axes.facecolor': 'none',
    'axes.edgecolor': COLORS['text'],
    'axes.labelcolor': COLORS['text'],
    'text.color': COLORS['text'],
    'xtick.color': COLORS['text'],
    'ytick.color': COLORS['text'],
    'figure.facecolor': 'none',
    'font.family': 'sans-serif',
    'font.size': 12,
})
# ============================================================

# Create chart with theme colors
fig, ax = plt.subplots(figsize=(8, 5), dpi=150)
bars = ax.bar(['Q1', 'Q2', 'Q3', 'Q4'], [25, 40, 35, 50],
              color=[COLORS['primary'], COLORS['secondary'], COLORS['primary'], COLORS['secondary']],
              edgecolor=COLORS['accent'], linewidth=1.5)
ax.set_title('Quarterly Revenue', fontsize=16, fontweight='bold', color=COLORS['text'])
ax.set_ylabel('Revenue ($M)', color=COLORS['text'])
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)

plt.tight_layout()
width_px, height_px = int(8 * 150), int(5 * 150)
plt.savefig(f'chart_{width_px}x{height_px}.png', dpi=150, transparent=True)
plt.close()
```

**Matplotlib palette templates:**

```python
# Midnight Executive
COLORS = {'primary': '#1E2761', 'secondary': '#CADCFC', 'accent': '#FFFFFF', 'text': '#1E2761'}

# Forest & Moss
COLORS = {'primary': '#2C5F2D', 'secondary': '#97BC62', 'accent': '#F5F5F5', 'text': '#2C5F2D'}

# Coral Energy
COLORS = {'primary': '#F96167', 'secondary': '#F9E795', 'accent': '#2F3C7E', 'text': '#2F3C7E'}

# Warm Terracotta
COLORS = {'primary': '#B85042', 'secondary': '#E7E8D1', 'accent': '#A7BEAE', 'text': '#B85042'}

# Teal Trust
COLORS = {'primary': '#028090', 'secondary': '#00A896', 'accent': '#02C39A', 'text': '#028090'}
```

Use for:
- Complex statistical charts (bar, line, pie, scatter, radar, etc.)
- Custom visualizations not supported by pptxgenjs
- Heatmaps, scatter plots, box plots

⚠️ Do NOT use matplotlib for:
- Architecture diagrams
- Flowcharts / process diagrams
- Org charts / hierarchy diagrams
- Network topology diagrams
- Any diagram that primarily shows relationships between components

These MUST be built with pptxgenjs native shapes so they render as editable PPT objects — not raster images.

**matplotlib - Charts with CJK Support**

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

**Option C: Web Search for Images**
```
Search for relevant images when:
- Stock photos or illustrations are needed
- Icons or logos are required
- Reference images for concepts
```

**Option D: Mermaid Diagrams (Last Resort)**

Use only when the diagram cannot be represented cleanly with native shapes/layout, and keep it consistent with the deck:

```bash
# Install if needed: npm install -g @mermaid-js/mermaid-cli
```

Create a theme config file matching your PPT palette:

```javascript
// mermaid-config.json - Example for "Ocean Gradient" theme
{
  "theme": "base",
  "themeVariables": {
    "primaryColor": "#065A82",
    "primaryTextColor": "#FFFFFF",
    "primaryBorderColor": "#21295C",
    "secondaryColor": "#1C7293",
    "secondaryTextColor": "#FFFFFF",
    "secondaryBorderColor": "#065A82",
    "tertiaryColor": "#E8F4F8",
    "tertiaryTextColor": "#21295C",
    "lineColor": "#21295C",
    "textColor": "#21295C",
    "mainBkg": "#E8F4F8",
    "nodeBorder": "#065A82",
    "clusterBkg": "#F0F7FA",
    "titleColor": "#21295C",
    "edgeLabelBackground": "#FFFFFF"
  }
}
```

```bash
cat > diagram.mmd << 'EOF'
graph LR
    A[Client] --> B[API Gateway]
    B --> C[Service A]
    B --> D[Service B]
EOF

# Prefer high resolution export for PPT usage
mmdc -i diagram.mmd -o diagram.png -c mermaid-config.json -b white -w 1600 --scale 2
```

### Step 3: Image Naming Convention (REQUIRED)

**All generated images MUST include dimensions in the filename:**

```
{name}_{width}x{height}.png
```

Examples:
- `architecture_800x600.png` - 800px wide, 600px tall
- `timeline_1200x400.png` - 1200px wide, 400px tall
- `chart_600x600.png` - 600px square

**When saving images, always include dimensions:**

```python
# Matplotlib example
fig, ax = plt.subplots(figsize=(8, 5), dpi=150)
# ... create chart ...
width_px = int(8 * 150)   # 1200
height_px = int(5 * 150)  # 750
plt.savefig(f'chart_{width_px}x{height_px}.png', dpi=150, transparent=True)
```

```bash
# Generic example - check output dimensions after generation
input="diagram_temp.png"
# Get actual dimensions and rename
dims=$(file "$input" | grep -oE '[0-9]+ x [0-9]+' | tr -d ' ')
mv "$input" "diagram_${dims/x/_x_}.png"
```

### Step 4: Verify Assets Before Proceeding

```bash
# Confirm all external assets exist with dimensions in filename
ls -la *_*x*.png *_*x*.jpg 2>/dev/null

# Verify dimensions match filename
for f in *_*x*.png; do
  echo "$f: $(file "$f" | grep -oE '[0-9]+ x [0-9]+')"
done
```

**Only proceed to code generation after:**
- [ ] Content plan is complete and approved
- [ ] All `[External]` assets are generated
- [ ] Asset files exist with `{name}_{width}x{height}.png` naming
- [ ] Filename dimensions match actual image dimensions

---

## ⚠️ CRITICAL: Slide Dimensions (REQUIRED FIRST)

**Before adding ANY elements, you MUST declare slide dimensions as constants at the top of your script.** This prevents layout overflow.

```javascript
// ============================================================
// SLIDE DIMENSIONS - DECLARE FIRST, USE EVERYWHERE
// ============================================================
// Choose ONE layout and define its dimensions:
pres.layout = 'LAYOUT_16x9';
const SLIDE_W = 10;      // inches
const SLIDE_H = 5.625;   // inches

// Define safe content area (with margins)
const MARGIN = 0.5;
const CONTENT_X = MARGIN;
const CONTENT_Y = MARGIN;
const CONTENT_W = SLIDE_W - (2 * MARGIN);  // 9 inches
const CONTENT_H = SLIDE_H - (2 * MARGIN);  // 4.625 inches

// Common layout helpers
const CENTER_X = SLIDE_W / 2;              // 5 inches
const CENTER_Y = SLIDE_H / 2;              // 2.8125 inches
// ============================================================
```

**Available layouts and their dimensions:**

| Layout | Width | Height | Content Area (with 0.5" margins) |
|--------|-------|--------|----------------------------------|
| `LAYOUT_16x9` | 10" | 5.625" | 9" × 4.625" |
| `LAYOUT_16x10` | 10" | 6.25" | 9" × 5.25" |
| `LAYOUT_4x3` | 10" | 7.5" | 9" × 6.5" |

**USE these constants for ALL positioning:**
```javascript
// ❌ WRONG: Hardcoded values risk overflow
slide.addText("Title", { x: 0.5, y: 0.5, w: 9, h: 0.8 });

// ✅ CORRECT: Use dimension constants
slide.addText("Title", { x: CONTENT_X, y: CONTENT_Y, w: CONTENT_W, h: 0.8 });

// ✅ CORRECT: Calculate positions relative to dimensions
const cardW = (CONTENT_W - 0.3) / 2;  // Two cards with gap
slide.addShape(pres.shapes.RECTANGLE, { x: CONTENT_X, y: 1.5, w: cardW, h: 2 });
slide.addShape(pres.shapes.RECTANGLE, { x: CONTENT_X + cardW + 0.3, y: 1.5, w: cardW, h: 2 });
```

---

## ⚠️ CRITICAL: Container System (REQUIRED)

**Add this code at the beginning of EVERY pptxgenjs script (after dimension constants).** It provides:
1. **Text overflow protection** - auto-adds `autoFit: true` and `fit: "shrink"` to all text
2. **Nested containers** - add elements inside shapes using relative coordinates
3. **Automatic z-ordering** - child elements render on top of parents

```javascript
// ============================================================
// CONTAINER SYSTEM WITH TEXT OVERFLOW PROTECTION - REQUIRED
// ============================================================

// Image scaling helper - extracts dimensions from filename and calculates
// position/size to fit within target bounds while preserving aspect ratio
function parseImageDimensions(path) {
  const match = path.match(/_(\d+)x(\d+)\.(png|jpg|jpeg|gif|webp)$/i);
  if (match) return { width: parseInt(match[1]), height: parseInt(match[2]) };
  return null;
}

function calculateScaledImageOpts(opts) {
  const { path, w: targetW, h: targetH, x = 0, y = 0, ...rest } = opts;
  if (!path || !targetW || !targetH) return opts;

  const dims = parseImageDimensions(path);
  if (!dims) return opts;

  const imgAspect = dims.width / dims.height;
  const targetAspect = targetW / targetH;

  let scaledW, scaledH, offsetX = 0, offsetY = 0;

  if (imgAspect > targetAspect) {
    scaledW = targetW;
    scaledH = targetW / imgAspect;
    offsetY = (targetH - scaledH) / 2;
  } else {
    scaledH = targetH;
    scaledW = targetH * imgAspect;
    offsetX = (targetW - scaledW) / 2;
  }

  return {
    path,
    x: x + offsetX,
    y: y + offsetY,
    w: scaledW,
    h: scaledH,
    ...rest
  };
}

function createVirtualNode(type, data, parentX = 0, parentY = 0) {
  const opts = data.opts || {};
  const node = {
    type, data,
    absX: parentX + (opts.x || 0),
    absY: parentY + (opts.y || 0),
    w: opts.w || 0, h: opts.h || 0,
    children: []
  };
  node.addShape = function(shapeType, opts = {}) {
    const child = createVirtualNode('shape', { shapeType, opts }, node.absX, node.absY);
    node.children.push(child);
    return child;
  };
  node.addText = function(text, opts = {}) {
    const safeOpts = { fit: "shrink", ...opts };
    const bulletRe = /^(?:[\u2022\u2023\u25E6\u2043\u2219\u00B7\u25CF\u25CB\u2013\u2014]\s*|\-\s+)/;
    if (Array.isArray(text)) {
      text = text.map(item => {
        if (item && item.options && item.options.bullet && typeof item.text === 'string') {
          return { ...item, text: item.text.replace(bulletRe, '') };
        }
        return item;
      });
    }
    const child = createVirtualNode('text', { text, opts: safeOpts }, node.absX, node.absY);
    node.children.push(child);
    return child;
  };
  node.addImage = function(opts = {}) {
    const scaledOpts = calculateScaledImageOpts(opts);
    const child = createVirtualNode('image', { opts: scaledOpts }, node.absX, node.absY);
    node.children.push(child);
    return child;
  };
  node.addTable = function(tableData, opts = {}) {
    const child = createVirtualNode('table', { tableData, opts }, node.absX, node.absY);
    node.children.push(child);
    return child;
  };
  return node;
}

function flattenNode(node, realSlide, pres) {
  const absOpts = { ...node.data.opts, x: node.absX, y: node.absY };
  if (node.type === 'shape') realSlide.addShape(node.data.shapeType, absOpts);
  else if (node.type === 'text') realSlide.addText(node.data.text, absOpts);
  else if (node.type === 'image') realSlide.addImage(absOpts);
  else if (node.type === 'table') realSlide.addTable(node.data.tableData, absOpts);
  node.children.forEach(child => flattenNode(child, realSlide, pres));
}

const originalAddSlide = pres.addSlide.bind(pres);
pres.addSlide = function(options) {
  const realSlide = originalAddSlide(options);
  const virtualSlide = {
    children: [],
    _realSlide: realSlide,
    set background(val) { realSlide.background = val; },
    get background() { return realSlide.background; },
    addShape: function(shapeType, opts = {}) {
      const node = createVirtualNode('shape', { shapeType, opts }, 0, 0);
      this.children.push(node);
      return node;
    },
    addText: function(text, opts = {}) {
      const safeOpts = { fit: "shrink", ...opts };
      const node = createVirtualNode('text', { text, opts: safeOpts }, 0, 0);
      this.children.push(node);
      return node;
    },
    addImage: function(opts = {}) {
      const scaledOpts = calculateScaledImageOpts(opts);
      const node = createVirtualNode('image', { opts: scaledOpts }, 0, 0);
      this.children.push(node);
      return node;
    },
    addTable: function(tableData, opts = {}) {
      const node = createVirtualNode('table', { tableData, opts }, 0, 0);
      this.children.push(node);
      return node;
    },
    addChart: function(chartType, data, opts = {}) {
      realSlide.addChart(chartType, data, opts);
    },
    render: function() {
      this.children.forEach(child => flattenNode(child, realSlide, pres));
    }
  };
  return virtualSlide;
};
// ============================================================
```

### How to Use Containers

```javascript
// Create a card as a container
let card = slide.addShape(pres.shapes.RECTANGLE, {
  x: 1, y: 2, w: 4, h: 2.5,
  fill: { color: "FFFFFF" }
});

// Add content INSIDE the card - coordinates relative to card's top-left
card.addText("Title", { x: 0.2, y: 0.2, w: 3.6, h: 0.4, fontSize: 18 });
card.addText("Description", { x: 0.2, y: 0.7, w: 3.6, h: 1.5, fontSize: 12 });

// Nested containers work too
let iconBg = card.addShape(pres.shapes.OVAL, { x: 0.2, y: 1.8, w: 0.5, h: 0.5 });
iconBg.addText("✓", { x: 0, y: 0, w: 0.5, h: 0.5, align: "center" });

// ⚠️ REQUIRED: Call render() at end of each slide
slide.render();
```

**For multi-line text that should wrap**, explicitly disable overflow protection:
```javascript
slide.addText("Long paragraph...", {
  x: 1, y: 2, w: 8, h: 3,
  autoFit: false,  // Override the default
  fit: "none"      // Allow normal wrapping
});
```

### How to Use Images (Aspect Ratio Preserved)

**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.
**Images are automatically scaled to fit within the target bounds while preserving aspect ratio.** The image is centered in the target area with transparent margins.

### Generate Design System (Recommended)
**Requirements:**
1. Image filename MUST include dimensions: `{name}_{width}x{height}.png`
2. Specify target `w` and `h` in the options

For professional presentations, generate a comprehensive design system tailored to your topic:
```javascript
// Image is 800x600 pixels (4:3 aspect ratio)
// Target area is 4" x 4" (1:1 aspect ratio)
// Result: Image scaled to 4" x 3", centered vertically with 0.5" margin top/bottom
slide.addImage({
  path: "assets/architecture_800x600.png",
  x: 1,
  y: 1,
  w: 4,  // target width in inches
  h: 4   // target height in inches
});
```

```bash
python3 skills/pptx/scripts/design/search.py "<topic> <industry> <keywords>" --design-system -p "Presentation Name"
```

```javascript
// Inside a container - relative positioning
let card = slide.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 1, w: 5, h: 3 });
card.addImage({
  path: "assets/chart_1200x750.png",
  x: 0.2, y: 0.2,  // relative to card
  w: 4.6, h: 2.6   // target bounds
});
```

**Example:**
```bash
python3 skills/pptx/scripts/design/search.py "fintech blockchain startup pitch" --design-system -p "CryptoVenture Pitch"
```


This gives you:
- **Recommended style** (glassmorphism, minimalism, etc.)
- **Color palette** with primary, secondary, accent colors
- **Typography** with font pairings
- **Visual effects** (gradients, shadows, etc.)
- **Anti-patterns** to avoid


For additional design details:
```bash
# Get more color palette options
python3 skills/pptx/scripts/design/search.py "fintech crypto" --domain color

# Get typography alternatives
python3 skills/pptx/scripts/design/search.py "professional modern" --domain typography

# Get chart recommendations for data slides
python3 skills/pptx/scripts/design/search.py "comparison trend" --domain chart
```

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent. Never give all colors equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles, thick single-side borders. Carry it across every slide.

### Color Palettes

Choose colors that match your topic — don't default to generic blue. Use these palettes as inspiration:

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Midnight Executive** | `1E2761` (navy) | `CADCFC` (ice blue) | `FFFFFF` (white) |
| **Forest & Moss** | `2C5F2D` (forest) | `97BC62` (moss) | `F5F5F5` (cream) |
| **Coral Energy** | `F96167` (coral) | `F9E795` (gold) | `2F3C7E` (navy) |
| **Warm Terracotta** | `B85042` (terracotta) | `E7E8D1` (sand) | `A7BEAE` (sage) |
| **Ocean Gradient** | `065A82` (deep blue) | `1C7293` (teal) | `21295C` (midnight) |
| **Charcoal Minimal** | `36454F` (charcoal) | `F2F2F2` (off-white) | `212121` (black) |
| **Teal Trust** | `028090` (teal) | `00A896` (seafoam) | `02C39A` (mint) |
| **Berry & Cream** | `6D2E46` (berry) | `A26769` (dusty rose) | `ECE2D0` (cream) |
| **Sage Calm** | `84B59F` (sage) | `69A297` (eucalyptus) | `50808E` (slate) |
| **Cherry Bold** | `990011` (cherry) | `FCF6F5` (off-white) | `2F3C7E` (navy) |

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

**Layout options:**
- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

**Chart merge guidance (comparison/synergy):**
- Merge charts only when they answer the same question
- Prefer simple combinations: bar+line (scale + trend) or side-by-side bars (direct comparison)
- Keep the same basis for comparison: shared time axis, units, and metric definition
- Limit to 2-3 series and highlight one key takeaway

**Insight guidance for slides with visuals:**
- For any slide containing a chart/diagram, perform an explicit insight decision; default to adding insights unless the visual is purely decorative
- If insights are needed, add an appropriate number of short insight lines on the same slide (near the visual), written as conclusions instead of neutral descriptions
- Make each insight specific and data-tied (trend/change/comparison/exception), not generic statements
- Keep insights visually secondary to the chart title and chart itself (clear hierarchy, no clutter)

**Visual polish:**
- Icons in small colored circles next to section headers
- Italic accent text for key stats or taglines

### Typography

**Title fonts MUST be serif.** Cover title, slide titles, and subtitles (if present) must use a serif font. Only fall back to sans-serif if no serif font is available in the environment.

Recommended serif fonts for titles:
- **Latin**: Georgia, Cambria, Palatino Linotype, Garamond, Times New Roman
- **CJK**: Songti SC, SimSun, Noto Serif CJK SC, Source Han Serif SC

**Font pairing** — pair a serif header font with a clean sans-serif body font:

| Header Font (serif) | Body Font |
|---------------------|-----------|
| Georgia | Calibri |
| Cambria | Calibri |
| Cambria | Calibri Light |
| Palatino Linotype | Calibri |
| Palatino | Garamond |
| Garamond | Calibri Light |
| Times New Roman | Arial |

| Element | Size | charSpacing |
|---------|------|-------------|
| Cover title | 36-44pt bold, **serif** | — |
| Slide title | 28-36pt bold, **serif** | — |
| Subtitle | 18-24pt, **serif** | — |
| Section header | 20-24pt bold | — |
| Body text | 14-16pt | — |
| Captions | 10-12pt muted | — |

**Serif font charSpacing rule** — apply `charSpacing` based on font size to prevent cramped text:

| Font size | charSpacing |
|-----------|-------------|
| ≥ 36pt | 2.5 pt |
| 24-35pt | 1.5 pt |
| 18-23pt | 1 pt |
| 12-17pt | 0.5 pt |
| < 12pt | 0 (default) |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Avoid (Common Mistakes)

- **⚠️ Don't forget to declare slide dimension constants FIRST** — see "CRITICAL: Slide Dimensions" section above; define `SLIDE_W`, `SLIDE_H`, `CONTENT_W`, `CONTENT_H` at the start of EVERY script
- **⚠️ Don't hardcode coordinates** — use dimension constants (`CONTENT_X`, `CONTENT_W`, etc.) for ALL positioning to prevent overflow
- **⚠️ Don't forget to add the container system code** — see "CRITICAL: Container System" section above; add it after dimension constants
- **⚠️ Don't forget to call `slide.render()`** — required at the end of each slide to flatten virtual nodes
- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use horizontal lines to seperate title and body** — use whitespace or background color instead
- **⚠️ Don't leave slides blank** — every `addSlide()` call must be followed by at least one `addText`/`addShape`/`addImage` and a `slide.render()`. A slide with only `background` set and no elements is a P0 defect that will be caught by `validate_layout.py`

---

## Layout Safety (Required Before QA)

Fixing overflow only in QA is too late. Prevent it in code first.

1. Pick layout by required Y-range:
   - `LAYOUT_16x9` height = 5.625
   - `LAYOUT_16x10` height = 6.25
   - `LAYOUT_4x3` height = 7.5
   - `LAYOUT_WIDE` height = 7.5
2. Define margins before placing elements:
   - Default: `left/right/top/bottom = 0.5`
3. Build every element inside content frame:
   - `contentX = marginLeft`
   - `contentY = marginTop`
   - `contentW = slideW - marginLeft - marginRight`
   - `contentH = slideH - marginTop - marginBottom`
4. Enforce boundary rule for every shape/text/image/chart:
   - `x >= marginLeft`
   - `y >= marginTop`
   - `x + w <= slideW - marginRight`
   - `y + h <= slideH - marginBottom`
5. For uncertain text lengths, reserve vertical slack:
   - Keep at least `0.3"` gap between stacked blocks
   - Leave `>= 0.4"` extra bottom slack in text-heavy slides

If your design requires `y + h > 5.625`, do not use `LAYOUT_16x9`.

---

## QA (Required)

**Assume there are problems. Your job is to find them.**

Your first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

### Layout QA (MANDATORY — Run After Every Build)

⚠️ **This is a mandatory gate. You MUST pass this before declaring the presentation complete.**

**From-scratch (pptxgenjs) — fix and validate all slides:**

```bash
python3 scripts/fix_pptx.py output.pptx
python3 scripts/validate_layout.py output.pptx
```

**Template editing — validate only edited slides:**

```bash
python3 scripts/validate_layout.py output.pptx --slides 3,5,8
```

**Rules:**
1. If the report shows `Issues: 0` → pass.
2. If `Issues: > 0` → fix only the affected slides, rebuild, then re-run. **Repeat until 0 issues.**
3. **`blank_slide` is a generation defect — NEVER skip it.** A blank slide means your code failed to add content to that slide. Fix by adding the intended content (text, shapes, images). Do NOT dismiss it as "a known limitation" or "section divider that the validator can't see" — if the validator says it's blank, it IS blank.
4. **Maximum 3 retry rounds.** If issues persist after 3 rounds of fixes, report the remaining issues to the user and proceed — do not loop indefinitely.
5. **Do NOT skip the first run.** Do NOT declare success while issues remain (unless retry limit reached).

For debugging details:

```bash
python3 scripts/validate_layout.py output.pptx --verbose
```

### Content QA

```bash
python3 -m markitdown output.pptx
```

Check for missing content, typos, wrong order.

Also verify insight coverage:
- For each slide with chart/diagram content, confirm an explicit insight decision exists
- If the visual carries analytical meaning, ensure insight text is present on-slide (not only in speaker notes)

**When using templates, check for leftover placeholder text:**

```bash
python3 -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|this.*(page|slide).*layout"
```

> **Windows (PowerShell):** Use `python3 -m markitdown output.pptx | Select-String -Pattern "xxxx|lorem|ipsum|this.*(page|slide).*layout"` since `grep` is not available on Windows.

If grep returns results, fix them before declaring success.

### Overlap Prevention

 - **Text vs Text**: Ensure text boxes have `autoFit` or fixed height. If height is dynamic, calculate Y for the *next* element based on previous text length.
 - **Text vs Image**: Never place text directly over images without a semi-transparent background shape or high-contrast overlay.
 - **Chart Legends**: Legends often grow. Reserve 20% more width than expected or place legends at the bottom.
 - **Table Content**: Long words in narrow columns will wrap and increase row height, pushing lower content off-slide.

---

## Dependencies

- `pip install "markitdown[pptx]"` - text extraction
- `pip install Pillow` - thumbnail grids
- `npm install pptxgenjs` - project dependency for creating from scratch
