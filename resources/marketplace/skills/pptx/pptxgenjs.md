# PptxGenJS Tutorial

## Setup & Basic Structure

```javascript
const pptxgen = require("pptxgenjs");

let pres = new pptxgen();
pres.author = 'Your Name';
pres.title = 'Presentation Title';

// ============================================================
// ⚠️ SLIDE DIMENSIONS - REQUIRED FIRST, USE EVERYWHERE
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

// ============================================================
// ⚠️ CONTAINER SYSTEM - REQUIRED IN EVERY SCRIPT
// ============================================================
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
    const child = createVirtualNode('image', { opts }, node.absX, node.absY);
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
      const node = createVirtualNode('image', { opts }, 0, 0);
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

let slide = pres.addSlide();
slide.addText("Hello World!", { x: 0.5, y: 0.5, fontSize: 36, color: "363636" });
slide.render();
pres.layout = 'LAYOUT_16x9';  // or 'LAYOUT_16x10', 'LAYOUT_4x3', 'LAYOUT_WIDE'
pres.author = 'Your Name';
pres.title = 'Presentation Title';

let slide = pres.addSlide();
slide.addText("Hello World!", { x: 0.5, y: 0.5, fontSize: 36, color: "363636" });

pres.writeFile({ fileName: "Presentation.pptx" });
```

## Layout Dimensions

Slide dimensions (coordinates in inches):
- `LAYOUT_16x9`: 10" × 5.625" (default)
- `LAYOUT_16x10`: 10" × 6.25"
- `LAYOUT_4x3`: 10" × 7.5"
- `LAYOUT_WIDE`: 13.3" × 7.5"

---

## Layout Safety (Prevent Overflow Before QA)

Do layout checks in code before rendering. QA should validate, not discover basic bounds errors.

### 1) Pick layout from required canvas

If your lowest element has `y + h = 6.6`, `LAYOUT_16x9` will overflow. Choose a 7.5" high layout (`LAYOUT_4x3` or `LAYOUT_WIDE`) or compress the layout.

### 2) Reserve margins and content frame first

```javascript
const LAYOUT_SIZE = {
  LAYOUT_16x9: { w: 10, h: 5.625 },
  LAYOUT_16x10: { w: 10, h: 6.25 },
  LAYOUT_4x3: { w: 10, h: 7.5 },
  LAYOUT_WIDE: { w: 13.3, h: 7.5 }
};

const MARGIN = { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5 };

function getContentFrame(layout) {
  const size = LAYOUT_SIZE[layout];
  return {
    slideW: size.w,
    slideH: size.h,
    x: MARGIN.left,
    y: MARGIN.top,
    w: size.w - MARGIN.left - MARGIN.right,
    h: size.h - MARGIN.top - MARGIN.bottom
  };
}
```

### 3) Guard every element by boundary rule

```javascript
function assertInBounds(box, frame, id) {
  const right = frame.slideW - MARGIN.right;
  const bottom = frame.slideH - MARGIN.bottom;
  if (box.x < MARGIN.left || box.y < MARGIN.top || box.x + box.w > right || box.y + box.h > bottom) {
    throw new Error(`Out of bounds: ${id} (${box.x}, ${box.y}, ${box.w}, ${box.h})`);
  }
}
```

Before each `addText` / `addShape` / `addImage` / `addChart`, run `assertInBounds`.

### 4) Use stack layout for vertical blocks

Avoid hardcoded random `y` values. Stack sections with consistent gap:

```javascript
function stackY(startY, blocks, gap) {
  const positions = [];
  let y = startY;
  for (const h of blocks) {
    positions.push(y);
    y += h + gap;
  }
  return positions;
}
```

For text-heavy slides, use `gap >= 0.3` and keep at least `0.4` unused space at the bottom.

### 5) Scale coordinates when switching layouts

```javascript
function scaleBox(box, from, to) {
  return {
    x: box.x * (to.w / from.w),
    y: box.y * (to.h / from.h),
    w: box.w * (to.w / from.w),
    h: box.h * (to.h / from.h)
  };
}
```

This prevents partial migration errors when moving from `LAYOUT_WIDE`/`4x3` coordinates to `16x9`.

### 6) Prevent Overlap
 
 Use a simple collision detector for dynamic layouts (like dashboards or generated content).
 
 ```javascript
 const placedBoxes = [];
 
 function addBox(id, x, y, w, h) {
   const newBox = { id, x, y, w, h, r: x + w, b: y + h };
   
   for (const box of placedBoxes) {
     if (x < box.r && x + w > box.x && y < box.b && y + h > box.y) {
       console.warn(`OVERLAP DETECTED: ${id} overlaps with ${box.id}`);
       // Strategy: Shift down or resize
       y = box.b + 0.2; 
     }
   }
   
   placedBoxes.push({ id, x, y, w, h, r: x + w, b: y + h });
   return { x, y };
 }
 ```
 
 ---
 
 ## Text & Formatting

**Title fonts MUST be serif.** Use a serif font (e.g., Georgia, Cambria, Palatino Linotype) for cover titles, slide titles, and subtitles. Body text should use a clean sans-serif font (e.g., Calibri, Arial). Only fall back to sans-serif for titles if no serif font is available.

**Serif charSpacing rule** — apply based on font size: ≥36pt → 2.5, 24-35pt → 1.5, 18-23pt → 1, 12-17pt → 0.5, <12pt → 0.

```javascript
// Cover title (44pt → charSpacing 2.5)
slide.addText("Presentation Title", {
  x: 1, y: 2, w: 8, h: 2, fontSize: 44, fontFace: "Georgia",
  color: "363636", bold: true, align: "center", valign: "middle",
  charSpacing: 2.5
});

// Slide title (32pt → charSpacing 1.5)
slide.addText("Slide Title", {
  x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 32, fontFace: "Georgia",
  color: "363636", bold: true, charSpacing: 1.5
});

// Subtitle (20pt → charSpacing 1)
slide.addText("A brief subtitle here", {
  x: 0.5, y: 1.2, w: 9, h: 0.6, fontSize: 20, fontFace: "Georgia",
  color: "666666", charSpacing: 1
});

// Body text — use sans-serif font
slide.addText("Body content here", {
  x: 1, y: 4, w: 8, h: 1, fontSize: 16, fontFace: "Calibri",
  color: "363636"
});

// Rich text arrays
slide.addText([
  { text: "Bold ", options: { bold: true } },
  { text: "Italic ", options: { italic: true } }
], { x: 1, y: 3, w: 8, h: 1 });

// Multi-line text (requires breakLine: true)
slide.addText([
  { text: "Line 1", options: { breakLine: true } },
  { text: "Line 2", options: { breakLine: true } },
  { text: "Line 3" }  // Last item doesn't need breakLine
], { x: 0.5, y: 0.5, w: 8, h: 2 });

// Text box margin (internal padding)
slide.addText("Title", {
  x: 0.5, y: 0.3, w: 9, h: 0.6,
  margin: 0  // Use 0 when aligning text with other elements like shapes or icons
});
```

**Tip:** Text boxes have internal margin by default. Set `margin: 0` when you need text to align precisely with shapes, lines, or icons at the same x-position.

### Contrast Checker (WCAG)

Use this helper to validate text/background pairs before assigning colors:

```javascript
function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255
  };
}

function linearize(v) {
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(fgHex, bgHex) {
  const l1 = luminance(fgHex);
  const l2 = luminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function isContrastSafe(fgHex, bgHex, isLargeText = false) {
  const ratio = contrastRatio(fgHex, bgHex);
  return ratio >= (isLargeText ? 3 : 4.5);
}

const textColor = "F8FAFC";
const bgColor = "1F2937";
if (!isContrastSafe(textColor, bgColor, false)) {
  throw new Error(`Low contrast: ${textColor} on ${bgColor}`);
}
```

---

## Lists & Bullets

```javascript
// ✅ CORRECT: Multiple bullets
slide.addText([
  { text: "First item", options: { bullet: true, breakLine: true } },
  { text: "Second item", options: { bullet: true, breakLine: true } },
  { text: "Third item", options: { bullet: true } }
], { x: 0.5, y: 0.5, w: 8, h: 3 });

// ❌ WRONG: Never use unicode bullets
slide.addText("• First item", { ... });  // Creates double bullets

// Sub-items and numbered lists
{ text: "Sub-item", options: { bullet: true, indentLevel: 1 } }
{ text: "First", options: { bullet: { type: "number" }, breakLine: true } }
```

---

## Shapes

```javascript
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 0.8, w: 1.5, h: 3.0,
  fill: { color: "FF0000" }, line: { color: "000000", width: 2 }
});

slide.addShape(pres.shapes.OVAL, { x: 4, y: 1, w: 2, h: 2, fill: { color: "0000FF" } });

slide.addShape(pres.shapes.LINE, {
  x: 1, y: 3, w: 5, h: 0, line: { color: "FF0000", width: 3, dashType: "dash" }
});

// With transparency
slide.addShape(pres.shapes.RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: "0088CC", transparency: 50 }
});
```

**Note**: Gradient fills are not natively supported. Use a gradient image as a background instead.

### Building Diagrams with Native Shapes

Architecture diagrams, flowcharts, and process diagrams MUST use native shapes — never matplotlib or external image generators.

**Design guidelines:**
- Add `shadow` to nodes for depth (blur: 3-5, opacity: 0.2-0.3)
- Use a single color family with varying lightness for nodes (e.g., dark → medium → light)
- Keep connector lines thinner (1.5pt) and lighter than node fills (e.g., gray)
- Center the diagram horizontally: `startX = (10 - totalWidth) / 2`
- Maintain equal spacing between nodes
- Use ROUNDED_RECTANGLE (rectRadius: 0.1-0.15) instead of sharp RECTANGLE
- White bold text on dark fills for readability

**Example 1 — Vertical Architecture Diagram:**

```javascript
const layers = [
  { label: "Presentation Layer", color: "065A82" },
  { label: "Business Logic",     color: "1C7293" },
  { label: "Data Access Layer",  color: "21295C" },
];
const nodeW = 4, nodeH = 0.8, gap = 1.2;
const startX = (10 - nodeW) / 2, startY = 1.2;
const nodeShadow = { type: "outer", blur: 4, offset: 2, color: "000000", opacity: 0.25 };

layers.forEach((layer, i) => {
  const y = startY + i * gap;
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: startX, y, w: nodeW, h: nodeH,
    fill: { color: layer.color }, rectRadius: 0.1, shadow: nodeShadow
  });
  slide.addText(layer.label, {
    x: startX, y, w: nodeW, h: nodeH,
    align: "center", valign: "middle",
    color: "FFFFFF", fontSize: 14, bold: true
  });
  if (i < layers.length - 1) {
    slide.addShape(pres.shapes.LINE, {
      x: startX + nodeW / 2, y: y + nodeH,
      w: 0, h: gap - nodeH,
      line: { color: "999999", width: 1.5, endArrowType: "triangle" }
    });
  }
});
```

**Example 2 — Horizontal Flowchart:**

```javascript
const steps = ["Plan", "Design", "Build", "Deploy"];
const colors = ["065A82", "1C7293", "21295C", "0A4D68"];
const nodeW = 1.8, nodeH = 0.9, hGap = 0.6;
const totalW = steps.length * nodeW + (steps.length - 1) * hGap;
const startX = (10 - totalW) / 2, nodeY = 2.2;
const nodeShadow = { type: "outer", blur: 4, offset: 2, color: "000000", opacity: 0.25 };

steps.forEach((label, i) => {
  const x = startX + i * (nodeW + hGap);
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y: nodeY, w: nodeW, h: nodeH,
    fill: { color: colors[i] }, rectRadius: 0.15, shadow: nodeShadow
  });
  slide.addText(label, {
    x, y: nodeY, w: nodeW, h: nodeH,
    align: "center", valign: "middle",
    color: "FFFFFF", fontSize: 13, bold: true
  });
  if (i < steps.length - 1) {
    slide.addShape(pres.shapes.LINE, {
      x: x + nodeW, y: nodeY + nodeH / 2,
      w: hGap, h: 0,
      line: { color: "999999", width: 1.5, endArrowType: "triangle" }
    });
  }
});
```

---

## Images

### Image Sources

```javascript
// From file path
slide.addImage({ path: "images/chart.png", x: 1, y: 1, w: 5, h: 3 });

// From URL
slide.addImage({ path: "https://example.com/image.jpg", x: 1, y: 1, w: 5, h: 3 });

// From base64 (faster, no file I/O)
slide.addImage({ data: "image/png;base64,iVBORw0KGgo...", x: 1, y: 1, w: 5, h: 3 });
```

### Image Options

```javascript
slide.addImage({
  path: "image.png",
  x: 1, y: 1, w: 5, h: 3,
  rotate: 45,              // 0-359 degrees
  rounding: true,          // Circular crop
  transparency: 50,        // 0-100
  flipH: true,             // Horizontal flip
  flipV: false,            // Vertical flip
  altText: "Description",  // Accessibility
  hyperlink: { url: "https://example.com" }
});
```

### Image Sizing Modes

```javascript
// Contain - fit inside, preserve ratio
{ sizing: { type: 'contain', w: 4, h: 3 } }

// Cover - fill area, preserve ratio (may crop)
{ sizing: { type: 'cover', w: 4, h: 3 } }

// Crop - cut specific portion
{ sizing: { type: 'crop', x: 0.5, y: 0.5, w: 2, h: 2 } }
```

### Calculate Dimensions (preserve aspect ratio)

```javascript
const origWidth = 1978, origHeight = 923, maxHeight = 3.0;
const calcWidth = maxHeight * (origWidth / origHeight);
const centerX = (10 - calcWidth) / 2;

slide.addImage({ path: "image.png", x: centerX, y: 1.2, w: calcWidth, h: maxHeight });
```

### Supported Formats

- **Standard**: PNG, JPG, GIF (animated GIFs work in Microsoft 365)
- **SVG**: Works in modern PowerPoint/Microsoft 365

---

## Icons

Use react-icons to generate SVG icons, then rasterize to PNG for universal compatibility.

### Setup

```javascript
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const { FaCheckCircle, FaChartLine } = require("react-icons/fa");

function renderIconSvg(IconComponent, color = "#000000", size = 256) {
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(IconComponent, { color, size: String(size) })
  );
}

async function iconToBase64Png(IconComponent, color, size = 256) {
  const svg = renderIconSvg(IconComponent, color, size);
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + pngBuffer.toString("base64");
}
```

### Add Icon to Slide

```javascript
const iconData = await iconToBase64Png(FaCheckCircle, "#4472C4", 256);

slide.addImage({
  data: iconData,
  x: 1, y: 1, w: 0.5, h: 0.5  // Size in inches
});
```

**Note**: Use size 256 or higher for crisp icons. The size parameter controls the rasterization resolution, not the display size on the slide (which is set by `w` and `h` in inches).

### Icon Libraries

Install: `npm install -g react-icons react react-dom sharp`

Popular icon sets in react-icons:
- `react-icons/fa` - Font Awesome
- `react-icons/md` - Material Design
- `react-icons/hi` - Heroicons
- `react-icons/bi` - Bootstrap Icons

---

## Slide Backgrounds

```javascript
// Solid color
slide.background = { color: "F1F1F1" };

// Color with transparency
slide.background = { color: "FF3399", transparency: 50 };

// Image from URL
slide.background = { path: "https://example.com/bg.jpg" };

// Image from base64
slide.background = { data: "image/png;base64,iVBORw0KGgo..." };
```

---

## Tables

```javascript
slide.addTable([
  ["Header 1", "Header 2"],
  ["Cell 1", "Cell 2"]
], {
  x: 1, y: 1, w: 8, h: 2,
  border: { pt: 1, color: "999999" }, fill: { color: "F1F1F1" }
});

// Advanced with merged cells
let tableData = [
  [{ text: "Header", options: { fill: { color: "6699CC" }, color: "FFFFFF", bold: true } }, "Cell"],
  [{ text: "Merged", options: { colspan: 2 } }]
];
slide.addTable(tableData, { x: 1, y: 3.5, w: 8, colW: [4, 4] });
```

---

## Charts

```javascript
// Bar chart
slide.addChart(pres.charts.BAR, [{
  name: "Sales", labels: ["Q1", "Q2", "Q3", "Q4"], values: [4500, 5500, 6200, 7100]
}], {
  x: 0.5, y: 0.6, w: 6, h: 3, barDir: 'col',
  showTitle: true, title: 'Quarterly Sales'
});

// Line chart
slide.addChart(pres.charts.LINE, [{
  name: "Temp", labels: ["Jan", "Feb", "Mar"], values: [32, 35, 42]
}], { x: 0.5, y: 4, w: 6, h: 3, lineSize: 3, lineSmooth: true });

// Pie chart
slide.addChart(pres.charts.PIE, [{
  name: "Share", labels: ["A", "B", "Other"], values: [35, 45, 20]
}], { x: 7, y: 1, w: 5, h: 4, showPercent: true });
```

### Better-Looking Charts

Default charts look dated. Apply these options for a modern, clean appearance:

```javascript
slide.addChart(pres.charts.BAR, chartData, {
  x: 0.5, y: 1, w: 9, h: 4, barDir: "col",

  // Custom colors (match your presentation palette)
  chartColors: ["0D9488", "14B8A6", "5EEAD4"],

  // Clean background
  chartArea: { fill: { color: "FFFFFF" }, roundedCorners: true },

  // Muted axis labels
  catAxisLabelColor: "64748B",
  valAxisLabelColor: "64748B",

  // Subtle grid (value axis only)
  valGridLine: { color: "E2E8F0", size: 0.5 },
  catGridLine: { style: "none" },

  // Data labels on bars
  showValue: true,
  dataLabelPosition: "outEnd",
  dataLabelColor: "1E293B",

  // Hide legend for single series
  showLegend: false,
});
```

**Key styling options:**
- `chartColors: [...]` - hex colors for series/segments
- `chartArea: { fill, border, roundedCorners }` - chart background
- `catGridLine/valGridLine: { color, style, size }` - grid lines (`style: "none"` to hide)
- `lineSmooth: true` - curved lines (line charts)
- `legendPos: "r"` - legend position: "b", "t", "l", "r", "tr"

---

## Slide Masters

```javascript
pres.defineSlideMaster({
  title: 'TITLE_SLIDE', background: { color: '283A5E' },
  objects: [{
    placeholder: { options: { name: 'title', type: 'title', x: 1, y: 2, w: 8, h: 2 } }
  }]
});

let titleSlide = pres.addSlide({ masterName: "TITLE_SLIDE" });
titleSlide.addText("My Title", { placeholder: "title" });
```

---

## Common Pitfalls

⚠️ These issues cause file corruption, visual bugs, or broken output. Avoid them.

1. **ALWAYS declare slide dimension constants FIRST** - define `SLIDE_W`, `SLIDE_H`, `CONTENT_W`, `CONTENT_H`, etc. before any content (see Setup & Basic Structure section). Use these constants for ALL positioning to prevent overflow.

2. **ALWAYS include the container system code** - add it right after dimension constants (see Setup & Basic Structure section). This provides text overflow protection and nested containers.

3. **ALWAYS call `slide.render()` at the end of each slide** - without this, nothing will appear in the output file.

4. **NEVER use "#" with hex colors** - causes file corruption
   ```javascript
   color: "FF0000"      // ✅ CORRECT
   color: "#FF0000"     // ❌ WRONG
   ```

5. **Use `bullet: true`** - NEVER unicode symbols like "•" (creates double bullets)

6. **Use `breakLine: true`** between array items or text runs together

7. **Avoid `lineSpacing` with bullets** - causes excessive gaps; use `paraSpaceAfter` instead

8. **Each presentation needs fresh instance** - don't reuse `pptxgen()` objects

9. **Don't use `ROUNDED_RECTANGLE` with accent borders** - rectangular overlay bars won't cover rounded corners. Use `RECTANGLE` instead.
   ```javascript
   // ❌ WRONG: Accent bar doesn't cover rounded corners
   slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 1, y: 1, w: 3, h: 1.5, fill: { color: "FFFFFF" } });
   slide.addShape(pres.shapes.RECTANGLE, { x: 1, y: 1, w: 0.08, h: 1.5, fill: { color: "0891B2" } });

   // ✅ CORRECT: Use RECTANGLE for clean alignment
   slide.addShape(pres.shapes.RECTANGLE, { x: 1, y: 1, w: 3, h: 1.5, fill: { color: "FFFFFF" } });
   slide.addShape(pres.shapes.RECTANGLE, { x: 1, y: 1, w: 0.08, h: 1.5, fill: { color: "0891B2" } });
   ```

---

## Post-Generation Fix & Validation (MANDATORY)

After generating the PPTX file, first run the post-processing fix, then layout validation:

```bash
python3 scripts/fix_pptx.py output.pptx
python3 scripts/validate_layout.py output.pptx
```

Fix only the affected slides and re-generate until 0 issues remain. See SKILL.md QA section for details.

---

## Quick Reference

- **Shapes**: RECTANGLE, OVAL, LINE, ROUNDED_RECTANGLE
- **Charts**: BAR, LINE, PIE, DOUGHNUT, SCATTER, BUBBLE, RADAR
- **Layouts**: LAYOUT_16x9 (10"×5.625"), LAYOUT_16x10, LAYOUT_4x3
- **Alignment**: "left", "center", "right"
- **Chart data labels**: "outEnd", "inEnd", "center"
