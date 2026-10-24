# Image & Diagram Guide

This directory provides the following drawing and image generation capabilities. All output is ultimately embedded in the HTML (inline `<svg>`, inline `<pre class="mermaid">`, external `assets/charts.js` for ECharts, or `<img src="assets/...">` for images), with no external CDN references.

***

## 1. Mermaid Diagrams

Inlined in HTML as `<pre class="mermaid">`, rendered to SVG at runtime by Mermaid.js.

### Supported Diagram Types

| File | Type |
|------|------|
| `mermaid/guide.md` | Overview & selection decision tree |
| `mermaid/flowchart.md` | Flowchart |
| `mermaid/sequence.md` | Sequence diagram |
| `mermaid/class.md` | Class diagram |
| `mermaid/state.md` | State diagram |
| `mermaid/er.md` | ER diagram |
| `mermaid/gantt.md` | Gantt chart |
| `mermaid/mindmap.md` | Mind map |
| `mermaid/timeline.md` | Timeline |
| `mermaid/gitgraph.md` | Git branch graph |
| `mermaid/quadrant.md` | Quadrant chart |
| `mermaid/journey.md` | User journey map |
| `mermaid/c4.md` | C4 architecture diagram |

### Usage

1. Read `mermaid/guide.md` for a syntax overview
2. Read the corresponding type reference file for full syntax and examples
3. Inline in HTML (mermaid.min.js must be referenced via `<script src>` to keep it offline-capable):

```html
<figure class="diagram">
  <pre class="mermaid">
flowchart LR
    A[Input] --> B{Decision}
    B -->|Yes| C[Action A]
    B -->|No| D[Action B]
  </pre>
  <figcaption>Figure 1: Decision Flow</figcaption>
</figure>
```

### Notes

- Each diagram focuses on one concept; split complex systems into multiple diagrams
- Node labels should be 2–5 words; max ~20 nodes per diagram
- Label all connections with their meaning
- Use `classDef` to assign semantic colors

***

## 2. ECharts (Recommended — Primary Choice for Data Visualization)

Reference `echarts.min.js` via `<script src>` in the HTML, and write all chart initialization logic in a separate external JS file (`assets/charts.js`). Charts render to SVG at runtime. No external CDN needed.

> 💡 **Use ECharts for all data visualization.** Colors must be derived from the report theme's CSS variables to ensure charts are visually consistent with the page.

### Supported Chart Types

| Type | Description |
|------|------|
| Bar / Diverging Bar | Category comparison, ranking |
| Line / Area | Time trends, multi-series comparison |
| Pie / Donut | Proportional distribution |
| Radar | Multi-dimensional comparison |
| Scatter | Distribution, correlation |
| Heatmap | Matrix density distribution |
| Sankey | Flow/conversion paths |
| Funnel | Funnel conversion |
| Gauge | Single KPI dashboard |
| Tree / Treemap | Hierarchical structure |
| Graph | Relationship network |

### Usage

1. Reference `echarts.min.js` in HTML via `<script src="./_shared/js/echarts.min.js"></script>`
2. Create container `<div>` elements in HTML
3. Write all chart logic in `assets/charts.js` (external file, NOT inline `<script>` blocks):

**HTML (index.html):**
```html
<figure class="chart-figure">
  <figcaption>Quarterly Revenue</figcaption>
  <div id="chart-revenue" style="width:100%; min-height:400px;"></div>
</figure>

<!-- At the end of <body> -->
<script src="./_shared/js/echarts.min.js"></script>
<script src="assets/charts.js"></script>
```

**External JS (assets/charts.js):**
```javascript
(function() {
  // Read theme colors once, reuse across all charts
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  // --- Chart: revenue ---
  var el = document.getElementById('chart-revenue');
  var chart = echarts.init(el, null, { renderer: 'svg' });
  chart.setOption({
    color: [accent, accent2],
    tooltip: { trigger: 'axis', appendToBody: true },
    xAxis: {
      type: 'category',
      data: ['Q1', 'Q2', 'Q3', 'Q4'],
      axisLine: { lineStyle: { color: rule } },
      axisLabel: { color: muted }
    },
    yAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: rule } },
      axisLabel: { color: muted },
      splitLine: { lineStyle: { color: rule, opacity: 0.3 } }
    },
    series: [{
      type: 'bar',
      data: [120, 200, 150, 80]
    }],
    animation: false
  });
  window.addEventListener('resize', function() { chart.resize(); });
})();
```

### Theme Color Integration

Chart colors **must** be read from the page `:root` CSS variables — no hardcoded color values:

| CSS Variable | Chart Usage |
|----------|----------|
| `--accent` | Primary series color (first series, main bar/line) |
| `--accent2` | Secondary series color (second series) |
| `--ink` | Title, legend text |
| `--muted` | Axis labels, secondary text |
| `--rule` | Axis lines, split lines |
| `--bg2` | Tooltip background |

Multi-series color expansion: generate derivative colors from `--accent` and `--accent2` via opacity or HSL offset.

### Notes

- Use SVG renderer: `echarts.init(el, null, { renderer: 'svg' })`
- **Derive colors from CSS variables** (`getComputedStyle`); hardcoded color values are forbidden
- `animation: false` — reports are static documents
- `tooltip.appendToBody: true` — prevents container overflow clipping
- Add a resize listener for each chart: `window.addEventListener('resize', ...)`
- All chart logic goes in external `assets/charts.js`; do NOT use inline `<script>` blocks for chart config
- `echarts.min.js` is referenced via `<script src>`; do not use a CDN

***

## 3. SVG Mini Charts (Extremely Simple Scenarios Only)

> ⚠️ **SVG charts are discouraged. Use ECharts for data visualization (see Section 2).** Only consider hand-written SVG when the graphic elements are extremely simple (e.g., a single progress bar, sparkline trend line, donut percentage) and data points ≤ 3. Use ECharts for any scenario involving axes, legends, or multi-series comparison.

Pure hand-written `<svg>` tags inlined directly in HTML with no external dependencies. All colors use CSS variables for theme compatibility.

### Supported Chart Types

| File | Type |
|------|------|
| `svg/mini_charts.md` | Horizontal bar, donut, progress bar, gauge, stacked column |
| `svg/sparkline.md` | Line/area/bar mini trend charts |
| `svg/world_map.md` | Geographic distribution map |

### Usage

1. Read the corresponding reference file for SVG templates and calculation formulas
2. Replace data values and inline `<svg>` tags directly in HTML
3. All `fill`/`stroke` values use CSS variables (`var(--accent)`, `var(--positive)`, etc.)

### Notes

- Keep the `viewBox` aspect ratio consistent with the actual rendered dimensions
- `stroke-linecap="round"` and `stroke-linejoin="round"` make lines smoother

***

## 4. Graphviz

Renders DOT language descriptions to PNG via `render_graphviz.py`, then base64-encodes and inlines into HTML.

### Usage

1. Write a `.dot` format graph description file
2. Call the render script to generate PNG:

```bash
python3 diagrams/render_graphviz.py input.dot output.png
```

3. Convert the output PNG to base64 for inline embedding:

```python
import base64
from pathlib import Path

data = Path("output.png").read_bytes()
data_url = f"data:image/png;base64,{base64.b64encode(data).decode('ascii')}"
```

```html
<figure class="diagram">
  <img src="data:image/png;base64,..." alt="Dependency Graph">
  <figcaption>Figure 2: Module Dependencies</figcaption>
</figure>
```

### Capabilities

- Directed / undirected graphs
- Automatic layout algorithms: dot (hierarchical), neato (spring), fdp (force-directed), circo (circular), twopi (radial)
- Subgraphs (subgraph / cluster)
- Rich node shapes and edge styles
- Automatic syntax error detection and location

***

## 5. PlantUML

Renders PlantUML format descriptions to PNG via `render_plantuml.py`, then base64-encodes and inlines into HTML.

### Usage

1. Write a `.puml` format diagram description file
2. Call the render script to generate PNG:

```bash
python3 diagrams/render_plantuml.py input.puml output.png
```

3. Convert the output PNG to base64 for inline embedding (same process as Graphviz)

### Capabilities

- Sequence, class, activity, component, deployment, object, and use case diagrams
- C4 model (Context / Container / Component / Code)
- Icon library support (AWS, Azure, K8s, etc.)
- Swimlanes, parallel branches, grouping
- Automatic syntax error detection and location

***

## 6. GenerateImage (AI Image Generation)

Calls the GenerateImage tool to generate illustrations, backgrounds, hero images, and conceptual visual assets, then base64-encodes and inlines into HTML.

### Usage

1. **Write a detailed prompt** describing the scene, style, color palette, and mood
2. **Choose `image_size`**:
   - `landscape_16_9` — 2560×1440, wide landscape
   - `landscape_4_3` — 2240×1680, standard landscape
   - `square` — 1920×1920, square
   - `portrait_4_3` — 1680×2240, portrait
   - `portrait_16_9` — 1440×2560, narrow portrait
3. **Call GenerateImage one by one**, saving as `{name}_{width}x{height}.png`
4. **Base64-encode and inline**:

```html
<figure class="diagram">
  <img src="data:image/png;base64,..." alt="Conceptual illustration">
  <figcaption>Figure 3: System Overview</figcaption>
</figure>
```

### Prompt Tips

- Be explicit about style: "a modern flat illustration of…" / "a photorealistic aerial view of…"
- Specify colors: "using warm tones of terracotta and sage green"
- Describe composition: "left side shows X, right side shows Y, with negative space for text overlay"
- Specify mood: "professional, clean, and minimal" vs "vibrant, energetic, and bold"
- Avoid text in images: AI-generated text is often garbled; overlay text as HTML elements
- Prefer illustration style: AI-generated photos can look uncanny

### Plan Each Image Individually

If a section needs three illustrations, plan three independent image assets and generate them one by one.

***

## 7. Web Search Image Lookup

Search and download external image assets (real photos, logos, brand assets, etc.), then base64-encode and inline into HTML.

### Usage

1. Search for target images
2. Download and base64-encode
3. Embed in HTML as `<img src="data:image/png;base64,...">`

> ⚠️ Online search results have inconsistent styles and may have copyright issues; use only when real assets are needed.
