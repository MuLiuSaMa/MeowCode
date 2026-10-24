---
name: html-report
description: Create any self-contained HTML deliverable except slides — research reports, whitepapers, PRDs, dashboards, portfolios, resumes, email templates, data visualizations, and more. Use when the user wants to produce a polished, visually designed HTML page or multi-page site for any purpose. The final deliverable is a self-contained directory (<name>.html + assets + _shared) deployed to the user's workspace with zero external dependencies.
---

## Step-by-step execution and dependencies

1. Follow this Skill's workflow in order. Before a step uses a library, command-line tool, runtime, or font, check only the dependencies required by that step; do not assume they are installed.
2. Reuse dependencies that are available. If one is missing, install only that dependency using the current OS and an available package manager, then verify it and retry the original step. Do not install the entire dependency list in advance.
3. Use the active Python environment (`python -m pip install <package>`, or the matching `python3`); create a task-local virtual environment if needed. Install Node.js libraries in the task project (`npm install <package>`) so the script can resolve them. For system tools and fonts, use the available OS package manager (for example, Homebrew on macOS, apt on Debian/Ubuntu, or winget on Windows).
4. Follow the host's permission flow when installation needs approval. If the package manager or required permission is unavailable, or installation/download fails, report the missing dependency and affected step; do not retry indefinitely or claim the step passed. Continue independent steps when possible.
5. Keep the original workflow and quality checks. Check fonts only when rendering requires them. Steps using only text, built-in tools, or self-contained HTML require no package installation; external tool access or authentication must be handled through the host, not a package manager.

## Step 1: Plan

**You MUST think through all the planning questions below before writing any HTML.** Writing a `plan.md` file is optional for short/simple reports — you may keep the plan in your reasoning instead of creating a file. For long, complex, multi-section reports (5+ chapters or involving multiple visuals), you SHOULD create a `plan.md` file in your temporary work directory to maintain consistency. Regardless of whether you write it down, every field below MUST be considered and decided upon. The plan drives all subsequent steps.

```markdown
# Report Plan

## Meta
- **Type**: [Research Report / Whitepaper / PRD / Proposal / etc.]
- **Topic**: [one-line topic description]
- **Audience**: [who will read this]
- **Language**: [match user's language]

## Design System

### Palette

**Design constraints**:
- Use font-size + font-weight + whitespace for hierarchy, not different font families
- Keep layouts responsive (collapse grids on mobile)
- Contrast ratio ≥ 4.5:1 for ink on bg (WCAG AA).

All styles in the final HTML use these CSS variables — no hardcoded hex elsewhere.
- **Background** (`--bg`): `#xxxxxx`
- **Surface** (`--bg2`): `#xxxxxx`
- **Text** (`--ink`): `#xxxxxx`
- **Text muted** (`--muted`): `#xxxxxx`
- **Border** (`--rule`): `#xxxxxx`
- **Accent** (`--accent`): `#xxxxxx`
- **Accent 2** (`--accent2`): `#xxxxxx`

### Typography
- **Heading font**: [font name from canvas-fonts/] — [rationale: why this font fits the topic/audience]
- **Body font**: [font name or same as heading] — [rationale]
- **Mono font**: [font name from canvas-fonts/]
- **Heading style**: [e.g. "all-caps 0.08em tracking" / "italic serif" / "bold sans flush-left" / "thin weight oversized"]
- **Body size**: [e.g. 16px / 15px / 17px]
- **Line height**: [e.g. 1.6 / 1.7 / 1.8]

### Layout
- **Max width**: [e.g. 860px / 960px / 1080px / full-bleed with content column]
- **Page structure**: [e.g. "centered single column" / "left-aligned with wide margin notes" / "full-width hero sections + narrow text blocks" / "two-column with sticky sidebar TOC"]
- **Section spacing**: [e.g. "3rem between sections" / "page-break-style large gaps" / "tight 1.5rem rhythm"]
- **Header style**: [e.g. "centered cover with subtitle" / "left-aligned editorial masthead" / "full-bleed hero image with overlaid text" / "minimal top-left title"]

### Components
- **Section headings (h2)**: [e.g. "no decoration" / "bottom border 2px accent" / "large left-margin number" / "uppercase small with rule below" / "colored background bar"]
- **Subsection headings (h3)**: [e.g. "accent color text" / "bold same color as body" / "indented with left border"]
- **Callouts/quotes**: [e.g. "left border 4px accent2" / "full-width bg2 band" / "indented italic block" / "card with subtle shadow"]
- **Cards/surfaces**: [e.g. "bg2 fill, no border, radius-md" / "white with 1px rule border" / "no cards, use whitespace only"]
- **Metric/stat display**: [e.g. "large number in accent + small label" / "grid of bg2 cards" / "inline bold numbers in text"]
- **Tables**: [e.g. "minimal with row borders only" / "striped rows" / "header in accent bg" / "borderless with strong header underline"]
- **Dividers/rules**: [e.g. "none — use whitespace" / "1px rule between major sections only" / "short centered 40px accent line" / "full-width hairline"]

### Visual personality (one sentence)
[e.g. "Warm editorial magazine feel with generous whitespace and serif elegance" / "Cold technical documentation with monospace accents and dense layout" / "Playful startup pitch with bold colors and oversized numbers" / "Academic paper aesthetic with footnotes and minimal decoration"]

## Structure
1. [Chapter 1 title] — [brief description]
2. [Chapter 2 title] — [brief description]
3. ...

## Visuals
<!-- Tool selection: ECharts (data charts) · Mermaid/PlantUML/Graphviz (structural diagrams) · Inline SVG (sparklines/maps only) · GenerateImage (illustrations/hero images) -->
| Visual | Type | Tool | Purpose |
|--------|------|------|---------|
| Chart 1 | [e.g. Pie] | ECharts | [what it shows] |
| Diagram 1 | [e.g. Flowchart] | Mermaid | [what it shows] |
| Diagram 2 | [e.g. Component] | PlantUML | [what it shows] |
| Diagram 3 | [e.g. Dependency Graph] | Graphviz | [what it shows] |
| Map 1 | [e.g. World Map] | SVG | [what it shows] |
| Illustration 1 | [e.g. Scene] | GenerateImage | [what it shows] |

## Key Arguments / Thesis
- [Core argument 1]
- [Core argument 2]
- [Core argument 3]
```

---

## Step 2: Write Content

Write the full report content following the planned structure. Guidelines:

- **Language consistency**: The entire report MUST use the same language as the user's query.
- **Evidence-based**: Support claims with data, examples, or logical reasoning.
- **Structured**: Use clear headings (H2 for chapters, H3 for sections, H4 for subsections).
- **Concise but thorough**: Aim for depth without padding. Every paragraph should advance the argument.
- **Professional tone**: Match formality to audience (academic for research, direct for PRDs).
- **Transitions**: Each section should flow logically to the next.
- **Key point emphasis**: For longer text sections, highlight key phrases or sentences to help readers quickly grasp the main points. Choose ONE of the following two methods per report and apply it consistently throughout — do NOT mix them:
  - **Method A — Bold**: Use `<strong>` to bold key phrases (suitable for formal/academic reports).
  - **Method B — Accent color**: Use `<mark class="key">` to highlight key phrases with the theme's accent color (suitable for modern/visual reports). Add corresponding CSS: `mark.key { background: none; color: var(--accent); font-weight: 600; }`

---

## Step 3.5: Citations & Sources

When the report uses evidence from searched or provided sources, apply these citation rules consistently.

### Inline Citations

Use superscript numbered links that jump to the corresponding source entry in the footer:

```html
<sup><a href="#cite-1">[1]</a></sup>
```

Multiple citations on the same claim:
```html
<sup><a href="#cite-2">[2]</a></sup><sup><a href="#cite-3">[3]</a></sup>
```

**Rules:**
- Use sequential integer numbering starting from 1.
- The display text is just `[N]` — do NOT include the raw `[cite:N]` format from model output anywhere in the final HTML.
- Every inline citation MUST have a corresponding entry in the Sources section.

### Sources Section (Footer)

Place an ordered list inside `<footer><div class="sources">`:

```html
<footer>
  <div class="sources">
    <h2>Sources</h2>
    <ol>
      <li id="cite-1">
        <span class="src-title">Author/Org, Document Title. Brief description.</span>
        <a class="src-url" href="https://example.com/source" target="_blank" rel="noopener">https://example.com/source</a>
      </li>
      <li id="cite-2">
        <span class="src-title">Author/Org, Document Title. Brief description.</span>
        <a class="src-url" href="https://example.com/other" target="_blank" rel="noopener">https://example.com/other</a>
      </li>
    </ol>
  </div>
</footer>
```

**Rules:**
- Use `<ol>` (ordered list), NOT `<p>` tags — the template CSS already styles `footer .sources ol` and `footer .sources li`.
- Each `<li>` MUST have `id="cite-N"` to serve as the anchor target for inline citation links.
- Source URLs MUST be clickable `<a href="...">` links with `target="_blank"`, NOT plain text or `<span>` elements.
- For user-uploaded documents without a URL, use: `<span class="src-url">User-uploaded document</span>` (no link needed).
- Do NOT include raw `[cite:N]` text in the list — the `<ol>` numbering handles this automatically.
- Source description should be concise: Author/Org, Title, one-line context.

### Required CSS (add to `<style>` if not already in template)

```css
/* Inline citations */
sup a {
  color: var(--accent);
  text-decoration: none;
  font-size: 0.75em;
  font-weight: 600;
}
sup a:hover {
  text-decoration: underline;
}

/* Sources list */
footer .sources ol {
  padding-left: 1.2rem;
  font-size: 0.85rem;
  color: var(--muted);
}
footer .sources li {
  margin-bottom: 0.5rem;
  overflow-wrap: break-word;
  word-break: break-all;
}
footer .sources .src-title {
  color: var(--ink);
  word-break: normal;
}
footer .sources .src-url {
  display: block;
  margin-top: 0.15rem;
  font-size: 0.82rem;
  color: var(--accent);
  word-break: break-all;
}
footer .sources a {
  word-break: break-all;
}
```

---

## Step 4: Build HTML

### Project Setup

First, scaffold the report directory **in the user's output directory**.

**Linux / macOS:**
```bash
bash <skill-dir>/scripts/new-report.sh <report-name> <output-dir>
```

**Windows (native PowerShell):**
```powershell
pwsh -File <skill-dir>/scripts/new-report.ps1 <report-name> <output-dir>
```

- **`<skill-dir>`**: The directory where this skill (html-report) is located.
- **`<report-name>`**: A slug for the report (e.g. `market-analysis-2024`).
- **`<output-dir>`**: The user's workspace directory for the final deliverable (as specified in your system prompt's file handling rules).

This creates `<output-dir>/<report-name>/<report-name>.html` + `<output-dir>/<report-name>/assets/` + `<output-dir>/<report-name>/_shared/js/` (empty) + `<output-dir>/<report-name>/_shared/fonts/` (empty). All authoring happens directly in this directory — there is no separate deploy step.

### HTML Comment Header

**Every HTML file** in the report MUST begin with this exact comment on line 1:

```html
<!-- Generated by Trae Work -->
<!DOCTYPE html>
...
```
If you create multiple HTML files (e.g. multi-page report), each one needs this comment.

### Authoring Architecture

During authoring, the HTML uses **real relative paths** that resolve directly — no path rewriting is needed. The `new-report.sh` scaffold creates a `_shared/` directory alongside the HTML. The model copies fonts to `_shared/fonts/` and JS libraries to `_shared/js/` on demand during authoring. All paths work as-is in the final deliverable.

**Path layout** (created by `new-report.sh`, paths are real and resolve during authoring):

| Resource | Path |
|----------|------|
| Shared JS (ECharts, Mermaid, Lightbox) | `./_shared/js/echarts.min.js` |
| Shared fonts (TTF) | `./_shared/fonts/FontName-Regular.ttf` |
| Report-local images | `assets/hero_1024x576.png` |

**Forbidden in authoring HTML**:
- Absolute local paths (`/tmp/...`, `file:///...`)
- Remote URLs (`https://cdn.example.com/...`)
- Base64-encoded assets (bloats the HTML unnecessarily)

**Allowed in authoring HTML**:
- `./_shared/js/` for shared JS libraries
- `./_shared/fonts/` for shared font files
- Relative paths to report-local assets (`assets/...`), including `assets/charts.js`
- Inline `<svg>...</svg>`
- Inline `<style>...</style>`
- `<script src="assets/charts.js"></script>` for chart logic (NOT inline `<script>` blocks)

### Styling

1. **Copy fonts** from `<skill-dir>/canvas-fonts/` to `<report>/_shared/fonts/`.
2. **Declare `@font-face`** in `<style>` using `./_shared/fonts/` paths (see Step 2.1).
3. **Define CSS variables** in `:root` (see Step 2.1).
4. **Write all styles** using only `var(--*)` references — no hardcoded colors or font names in CSS rules.

### PRD Visual Style Modes

For PRD-like HTML reports, choose a visual style mode from content context and user preference. This is a rendering decision owned by `html-report`; content skills should pass style context, not CSS.

| Style | Use Cases | Characteristics |
|---|---|---|
| Solid (default) | Traditional enterprise, government, finance, and formal contexts | Solid backgrounds, opaque borders, standard shadows |
| Fresh Gradient | General software, education, entertainment, startup products, and lighter/modern contexts | Low-saturation ambient gradients, frosted glass cards, gradient accents |

Fresh Gradient rules:

- Page base layer: use 2-3 low-saturation `radial-gradient` overlays with `opacity` 0.06-0.10.
- Cards/panels: use semi-transparent white such as `rgba(255,255,255,0.7)` plus `backdrop-filter: blur(10px)`.
- Accent: use `linear-gradient(135deg, primary, secondary)` for heading underlines, active indicators, and primary buttons.
- Borders and shadows: use low-opacity primary color, e.g. `rgba(primary, 0.1-0.15)` for borders and `rgba(primary, 0.06-0.12)` for shadows.
- Text: keep body text dark and readable; avoid gradient text except for statistical figures.

Trigger Fresh Gradient when the user mentions "fresh", "gradient", "frosted glass", "glassmorphism", or when the domain is General Software, Education, or Entertainment and no stricter formal style is requested. Otherwise use Solid.

### ECharts Inclusion

**⚠️ MANDATORY**: The `<script src>` tag below MUST appear in the final HTML. Without it, charts will not render. Do NOT omit it, do NOT replace it with inline script, and do NOT use a CDN URL.

Reference `echarts.min.js` via a `<script src>` tag pointing to the `_shared/js/` directory. **Copy the library on demand** before use:

```bash
cp <skill-dir>/assets/js/echarts.min.js <report-dir>/_shared/js/
```

```html
<!-- REQUIRED: place before </body>, before assets/charts.js -->
<script src="./_shared/js/echarts.min.js"></script>
```

**Common mistakes that break charts:**
- ❌ Omitting this tag entirely (charts won't work)
- ❌ Using a CDN URL like `https://cdn.jsdelivr.net/...`
- ❌ Writing chart init code directly in `<script>` instead of `assets/charts.js`
- ❌ Adding attributes before `src` (e.g. `<script type="..." src="...">`) — prefer `src` as the first attribute for clarity

### Chart Authoring Rules

- **Title required.** Every chart, diagram, and figure MUST have a visible title. Use `<figcaption>` inside a `<figure>` wrapper, or a heading element (e.g. `<h3>`) immediately before the chart container. Never render a chart without an accompanying title that describes what it shows.
- **External JS file.** All chart initialization logic MUST be written in a separate JS file at `assets/charts.js` (or split into multiple files like `assets/chart-revenue.js`). Do NOT write chart logic in inline `<script>` blocks within the HTML page.
- **Container.** Wrap in a `<figure>` with `<figcaption>`, then reference the external script:
  ```html
  <figure class="chart-figure">
    <figcaption>{chart_title}</figcaption>
    <div id="chart-[name]" style="width:100%;min-height:400px"></div>
  </figure>

  <!-- All chart scripts at the end of <body>, after containers are defined -->
  <script src="assets/charts.js"></script>
  ```

- **JS file structure.** Wrap all chart code in an IIFE to avoid polluting global scope:
  ```javascript
  // assets/charts.js
  (function() {
    var style = getComputedStyle(document.documentElement);
    var accent = style.getPropertyValue('--accent').trim();
    var accent2 = style.getPropertyValue('--accent2').trim();
    var ink = style.getPropertyValue('--ink').trim();
    var muted = style.getPropertyValue('--muted').trim();
    var rule = style.getPropertyValue('--rule').trim();
    var bg2 = style.getPropertyValue('--bg2').trim();

    // --- Chart: [name] ---
    var chart1 = echarts.init(document.getElementById('chart-[name]'), null, { renderer: 'svg' });
    chart1.setOption({ /* ... */ });
    window.addEventListener('resize', function() { chart1.resize(); });

    // --- Chart: [name2] ---
    // ...
  })();
  ```
- **Init.** `echarts.init(el, null, { renderer: 'svg' })`.
- **Colors.** Derive chart colors from CSS variables via `getComputedStyle` (read once at the top of the IIFE, reuse across all charts).
- **Tooltip.** Always include tooltip with `appendToBody: true`.
- **Animation.** Set `animation: false` — reports are static documents.
- **Resize listener.** ALWAYS include `window.addEventListener('resize', () => chart.resize())` for each chart instance.
- **ECharts ONLY.** All quantitative data charts (bar, line, pie, radar, heatmap, sankey, scatter, etc.) MUST use ECharts. Using matplotlib, seaborn, plotly, or any other external charting library to generate PNG/SVG images is **FORBIDDEN** for data visualization. The only exception is structural diagrams rendered via Mermaid/PlantUML/Graphviz as described in the Diagram Embedding section.
- **Heatmap container height.** When y-axis categories ≥ 6, use `.chart-container.tall` (min-height: 560px) or calculate as `categories × 50px + 120px` (for axes + visualMap). Never use `.short` for heatmaps with more than 5 y-axis items. Set `grid.top` ≥ 30 to prevent top rows from being clipped.
- **Heatmap data integrity.** Only include categories on x/y axes that have at least one data point in the series. Do NOT declare axis categories for which no heatmap value exists. Always set `splitArea: { show: false }` on heatmap charts.
- **Heatmap missing-data fallback.** If any grid cell legitimately has no data, fill it explicitly with value `'-'` and render as transparent background + `'N/A'` label in `muted` color. Example:
  ```javascript
  // Fill missing cells
  var fullData = data.slice();
  yData.forEach(function(_, yi) {
    xData.forEach(function(_, xi) {
      if (!data.some(function(d) { return d[0] === xi && d[1] === yi; })) {
        fullData.push([xi, yi, '-']);
      }
    });
  });
  // Series config
  series: [{
    type: 'heatmap',
    data: fullData,
    label: {
      show: true,
      formatter: function(p) { return p.value[2] === '-' ? 'N/A' : Number(p.value[2]).toFixed(2); },
      color: ink
    }
  }]
  // visualMap outOfRange
  visualMap: { ..., outOfRange: { color: 'transparent' } }
  ```

### ECharts Color Specification

All chart colors MUST be derived from the report's CSS variables to maintain visual consistency with the theme. Do NOT use hardcoded hex colors or library default palettes.

**Reading CSS variables (once at the top of `assets/charts.js` IIFE):**
```javascript
var style = getComputedStyle(document.documentElement);
var accent = style.getPropertyValue('--accent').trim();
var accent2 = style.getPropertyValue('--accent2').trim();
var ink = style.getPropertyValue('--ink').trim();
var muted = style.getPropertyValue('--muted').trim();
var rule = style.getPropertyValue('--rule').trim();
var bg2 = style.getPropertyValue('--bg2').trim();
```

**Color palette construction:**
- **Single-series charts** (line, bar, area): use `accent` as primary color
- **Multi-series charts**: build a palette by mixing `accent` and `accent2` with opacity variants:
  ```javascript
  color: [accent, accent2, muted, accent + '99', accent2 + '99']
  ```
- **Heatmap / continuous color mapping**: use `visualMap.inRange.color` derived from theme:
  ```javascript
  visualMap: { inRange: { color: [bg2, accent2, accent] } }
  ```
- **Diverging charts** (positive vs negative comparison): use `accent` for positive values and `accent2 + 'cc'` (or a darker muted tone) for negative values:
  ```javascript
  itemStyle: { color: function(params) { return params.value >= 0 ? accent : accent2; } }
  ```
- **Text elements** (axis labels, legend): use `muted` for secondary text, `ink` for primary text
- **Grid lines / axis lines**: use `rule`

**Forbidden in chart colors:**
- Rainbow or matplotlib-style colormaps (viridis, plasma, inferno, etc.)
- Hardcoded hex values that do not come from CSS variables
- Default ECharts color palette (the auto-assigned blues, greens, oranges)

### Diagram Embedding

**Mermaid**

1. **⚠️ MANDATORY**: Copy and reference `mermaid.min.js` via a `<script src>` tag (same as ECharts — copy on demand to `_shared/js/`). This tag MUST appear in the HTML:
   ```bash
   cp <skill-dir>/assets/js/mermaid.min.js <report-dir>/_shared/js/
   ```
   ```html
   <!-- REQUIRED: place before </body> -->
   <script src="./_shared/js/mermaid.min.js"></script>
   ```
2. Initialize: `mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' })`.
3. Write diagram code inside `<pre class="mermaid">` blocks.
4. For detailed syntax and diagram type selection, refer to Mermaid documentation.

```html
<figure class="diagram">
  <pre class="mermaid">
    flowchart LR
      A[Service A] --> B[Service B] --> C[(Database)]
  </pre>
  <figcaption>Figure X: System Architecture</figcaption>
</figure>
```

**PlantUML / Graphviz**

1. Write the diagram source code (`.puml` or `.dot` file).
2. Run the render script: `python diagrams/render_plantuml.py input.puml output.png` or `python diagrams/render_graphviz.py input.dot output.png`.
3. Save the resulting PNG to the report's `assets/` directory with a descriptive name.
4. Reference in HTML via relative path:
   ```html
   <figure class="diagram">
     <img src="assets/architecture_diagram.png" alt="[description]">
     <figcaption>Figure X: [Diagram Title]</figcaption>
   </figure>
   ```

**Inline SVG Components** (only for extremely simple graphics; prefer ECharts for data visualization)

1. Write inline `<svg>` elements directly in the HTML for simple visuals (sparklines, progress bars, mini gauges).
2. Use CSS variables (`var(--accent)`, `var(--rule)`, etc.) for all colors.
3. If the chart involves >3 data points, axes, legends, or any interactivity → use ECharts instead.

### Illustration Embedding

This is the **single authoritative guide** for generating and embedding images via `GenerateImage`.

#### Workflow

1. **Write a detailed prompt** describing the desired scene, style, color tones, and mood.
2. **Choose the right `image_size`** for the target aspect ratio:
   - `landscape_16_9` — wide landscape (2560×1440), for full-width illustrations
   - `landscape_4_3` — landscape (2240×1680), for content area illustrations
   - `square` — square (1920×1920)
   - `portrait_4_3` — portrait (1680×2240)
   - `portrait_16_9` — tall portrait (1440×2560)
3. **Call GenerateImage** — generate each image one by one. Save to the report's `assets/` directory with naming convention: `assets/{name}_{width}x{height}.png`. e.g. `assets/bg-cover_16x9.png`
4. **Verify assets** — confirm all planned images exist before proceeding:
   ```bash
   ls -la assets/*_*x*.png assets/*_*x*.jpg 2>/dev/null
   ```
5. **Reference in HTML via relative path**:
   ```html
   <img src="assets/hero_1024x576.png" alt="...">
   ```
   The report's `_shared/` directory and `assets/` directory are both included in the final output.

**Only proceed to further authoring after:**
- [ ] All planned `[GenerateImage]` assets from the plan are generated
- [ ] Asset files exist in `assets/` with `{name}_{width}x{height}.png` naming
- [ ] Filename dimensions match actual image dimensions

Do not mention this part to the user

#### Prompt Tips

- **Be specific about style**: "a modern flat illustration of…" or "a photorealistic aerial view of…"
- **Include color guidance**: "using warm tones of terracotta and sage green" to match the report palette
- **Describe composition**: "left side shows X, right side shows Y, with negative space for text overlay"
- **Specify mood**: "professional, clean, and minimal" vs "vibrant, energetic, and bold"
- **Avoid text in images**: Generated text is often garbled — add text as HTML elements instead
- **Prefer illustration style**: AI-generated photos can look uncanny — illustrations and stylized graphics produce better results

**Planning rule:** treat each image slot as a separate task. If one section uses three thumbnails, that means three planned image assets and three generated files, not one shared image.

#### HTML Layout Patterns

```html
<figure class="diagram">
  <img src="assets/product_interface_1024x576.png" alt="Product interface screenshot">
  <figcaption>Figure 1: Product main interface overview</figcaption>
</figure>
```

#### Side-by-side Comparison

```html
<div class="figure-row">
  <figure class="diagram">
    <img src="assets/before_1024x768.png" alt="Before optimization">
    <figcaption>Before</figcaption>
  </figure>
  <figure class="diagram">
    <img src="assets/after_1024x768.png" alt="After optimization">
    <figcaption>After</figcaption>
  </figure>
</div>
```

#### Image Grid

```html
<div class="figure-grid">
  <figure class="diagram">
    <img src="assets/scenario_a_1024x768.png" alt="Scenario A">
    <figcaption>Scenario A</figcaption>
  </figure>
  <figure class="diagram">
    <img src="assets/scenario_b_1024x768.png" alt="Scenario B">
    <figcaption>Scenario B</figcaption>
  </figure>
  <figure class="diagram">
    <img src="assets/scenario_c_1024x768.png" alt="Scenario C">
    <figcaption>Scenario C</figcaption>
  </figure>
  <figure class="diagram">
    <img src="assets/scenario_d_1024x768.png" alt="Scenario D">
    <figcaption>Scenario D</figcaption>
  </figure>
</div>
```

#### Annotated Screenshot

```html
<figure class="diagram annotated">
  <div class="annotated-wrapper">
    <img src="assets/feature_annotations_1024x576.png" alt="Feature annotations">
    <span class="annotation" style="top:20%;left:35%">① Navigation Bar</span>
    <span class="annotation" style="top:45%;left:60%">② Core Action Area</span>
    <span class="annotation" style="top:75%;left:25%">③ Status Panel</span>
  </div>
  <figcaption>Figure 3: Interface functional area annotations</figcaption>
</figure>
```

#### Inline Icon/Badge

```html
<p>
  The system supports three deployment modes:
  <img class="inline-icon" src="assets/icon_cloud_64x64.png" alt="Cloud"> Cloud,
  <img class="inline-icon" src="assets/icon_hybrid_64x64.png" alt="Hybrid"> Hybrid,
  <img class="inline-icon" src="assets/icon_onpremise_64x64.png" alt="On-premise"> On-premise
</p>
```

#### Required CSS

```css
/* Basic figure */
.diagram { margin: 2rem 0; text-align: center; }
.diagram img { max-width: 100%; height: auto; border: 1px solid var(--rule); border-radius: 4px; }
.diagram figcaption { font-size: 0.8rem; color: var(--muted); margin-top: 0.5rem; }

/* Chart figure (ECharts with title) */
.chart-figure { margin: 2rem 0; }
.chart-figure figcaption { font-size: 0.9rem; font-weight: 600; color: var(--ink); margin-bottom: 0.75rem; }

/* Side-by-side */
.figure-row { display: flex; gap: 1.5rem; margin: 2rem 0; }
.figure-row .diagram { flex: 1; margin: 0; }
.figure-row .diagram img { width: 100%; }

/* Grid */
.figure-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.5rem; margin: 2rem 0; }
.figure-grid .diagram { margin: 0; }
.figure-grid .diagram img { width: 100%; }

/* Annotated */
.annotated-wrapper { position: relative; display: inline-block; }
.annotation {
  position: absolute; font-size: 0.75rem; font-weight: 700;
  color: var(--accent); background: var(--bg); padding: 2px 6px;
  border: 1px solid var(--accent); border-radius: 4px;
  white-space: nowrap; transform: translate(-50%, -50%);
}

/* Inline icon */
.inline-icon { height: 1.2em; width: auto; vertical-align: middle; margin: 0 0.2em; }

/* Responsive */
@media (max-width: 600px) {
  .figure-row { flex-direction: column; }
  .figure-grid { grid-template-columns: 1fr; }
}
```

### Responsive & Print Design

- Max-width container centered with `margin: 0 auto`.
- `@media print` styles: hide interactive elements, ensure page breaks at chapter boundaries.
- Minimum font size `14px` for body text, `12px` for captions/footnotes.
- Charts maintain aspect ratio on resize.

### Mobile Adaptation

The HTML may be previewed on mobile devices. Follow these rules:

- **Tables**: Always wrap `<table>` in a `<div class="table-wrap">` container. The `.table-wrap` MUST have both `overflow-x: auto` and `overflow-y: auto` with a `max-height` constraint (default `600px`). This ensures tables scroll both horizontally on narrow screens and vertically when rows exceed the container height. On mobile (≤ 768px), the table is given a `min-width` that triggers horizontal scroll when the viewport is too narrow.
- **Tables in multi-column layouts**: NEVER place tables inside two-column or multi-column grid layouts (e.g. `.two-col`, `.insight-grid`, `.chart-grid.cols-2`). Tables with 4+ columns MUST use full-width single-column layout to avoid overflow.
- **References / Sources**: Long URLs must not overflow the page width. Apply `word-break: break-all` on source links and list items in the footer `.sources` section.
- **Body padding**: Reduced on mobile to maximize content area.
- **Grid layouts**: All multi-column grids collapse to single-column on small screens.

---

## Sub-Scenario References

Load sub-scenario references only from inside the `html-report` skill after `html-report` has been invoked. Other skills should delegate to `html-report` instead of reading these files directly.

| Reference | File | Load When |
|---|---|---|
| `interactive-prd` | `references/interactive-prd.md` | The invoked `html-report` skill receives a prototype-centered interactive PRD rendering task from `doc-writing-guide`; this file provides the corresponding split-screen HTML structure, visual system, CSS variables, interaction templates, responsive behavior, and accessibility rules |

---



---

## File Structure

```
html-report/
├── references/
│   └── interactive-prd.md   (structure + visual spec for prototype-centered PRDs)
├── SKILL.md                 (this file)
├── assets/
│   └── js/                  (shared JS libraries: echarts.min.js, mermaid.min.js)
├── canvas-fonts/            (shared font TTF files)
├── diagrams/                (diagram tools & references)
│   ├── mermaid/             (Mermaid syntax guides)
│   ├── svg/                 (inline SVG component references)
│   ├── render_graphviz.py
│   └── render_plantuml.py
├── scripts/
│   ├── new-report.sh        (scaffold a report directory — Linux/macOS)
│   └── new-report.ps1       (scaffold a report directory — Windows native PowerShell)
```

**Report directory** (created by `new-report.sh` in user's output directory):

```
<output-dir>/<report-name>/
├── <report-name>.html  (authoring HTML with real relative paths)
├── assets/             (report-local images, charts.js, rendered diagrams)
└── _shared/
    ├── js/             (JS libraries, copied on demand from skill assets/js/)
    └── fonts/          (font files, copied on demand from skill canvas-fonts/)
```
