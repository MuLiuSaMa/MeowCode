# Image & Asset Generation Guide

This guide covers how to prepare visual assets (illustrations, photos) before writing HTML slides. All external images must be generated and verified before proceeding to slide authoring.

***

| Visual Type                              | Recommended Approach                                         |
| ---------------------------------------- | ------------------------------------------------------------ |
| Bar / line / pie / radar chart           | **ECharts 模板**（`chart-*-echarts.html`），直接在 HTML 内联 |
| Sankey / heatmap / tree / graph          | **ECharts 模板**（`chart-sankey.html` 等），直接在 HTML 内联 |
| Process flow / Flowchart                 | HTML/CSS layout (`flow-diagram` template)                    |
| Icon grid / comparison layout            | Template slide with shapes (Built-in)                        |
| Architecture / dependency graph          | HTML/CSS layout (`arch-diagram` template)                    |
| Illustrations / hero images / backgrounds | GenerateImage (see Option A) · Web Search (see Option B)    |
| Conceptual / abstract visuals            | GenerateImage (see Option A)                                 |

**Decision guide:**
- **Numerical data / charts** → ECharts 模板（在 HTML 中内联，无需预生成图片）
- **Illustrations, backgrounds, hero images** → GenerateImage (Option A)
- **Flowcharts, architecture, diagrams** → HTML/CSS-based layouts (`arch-diagram`, `flow-diagram`, `mindmap`)
- **Stock photos, logos, brand assets** → Web Search (Option B) — ⚠️ last resort only

> 💡 **数据可视化请使用 ECharts 模板**（`chart-*-echarts.html`、`chart-sankey.html`、`chart-heatmap.html`、`chart-tree.html`、`chart-graph.html`），在 HTML 中内联即可，无需预生成图片。所有 ECharts 模板使用 SVG renderer，支持主题联动和矢量导出。

***

## Image Naming Convention (REQUIRED)

**All generated images MUST be saved into the `assets/` subdirectory and include dimensions in the filename:**

```
assets/{name}_{width}x{height}.png
```

Examples:

- `hero_1024x576.png` — 1024px wide, 576px tall
- `illustration_1024x768.png` — 1024px wide, 768px tall
- `headshot_1024x1024.png` — 1024px square

***

## Option A: GenerateImage (AI Image Generation) — Recommended

Use GenerateImage to generate illustrations, backgrounds, hero images, and conceptual visuals directly. This is the preferred approach for custom imagery — it produces images that match the deck's style and color palette without relying on external search results.

### When to Use

- Full-bleed slide backgrounds or hero images
- Conceptual / abstract illustrations for content slides
- Supporting visuals when no real photo is required
- Any image where style coherence with the deck matters

### Workflow

1. **Write a detailed prompt** describing the desired scene, style, color tones, and mood.
2. **Choose the right `image_size`** for the target aspect ratio:
   - `landscape_16_9` — wide landscape (2560×1440), for full-slide backgrounds
   - `landscape_4_3` — landscape (2240×1680), for content area illustrations
   - `square` — square (1920×1920)
   - `portrait_4_3` — portrait (1680×2240)
   - `portrait_16_9` — tall portrait (1440×2560)
3. **Call GenerateImage directly** (no subagent needed). Generate each image one by one.
4. **Save and rename** to `{name}_{width}x{height}.png` in the `assets/` directory.

**Planning rule:** treat each image slot as a separate task. If one slide uses three thumbnails or cards, that means three planned image assets and three generated files, not one shared image.

### Prompt Tips

- **Be specific about style**: "a modern flat illustration of…" or "a photorealistic aerial view of…"
- **Include color guidance**: "using warm tones of terracotta and sage green" to match the slide palette
- **Describe composition**: "left side shows X, right side shows Y, with negative space for text overlay"
- **Specify mood**: "professional, clean, and minimal" vs "vibrant, energetic, and bold"
- **Avoid text in images**: Generated text is often garbled — add text as HTML elements instead
- **Prefer illustration style**: AI-generated photos can look uncanny — illustrations and stylized graphics produce better results

***

## Option B: Web Search for Images (⚠️ Not Recommended)

> ⚠️ **Prefer GenerateImage (Option A) over web search.** Online search results are often low-quality, inconsistent in style, and may have licensing issues. Only use web search as a last resort for assets that cannot be generated — such as real company logos or authentic brand materials.

Search for relevant images **only** when:

- Real stock photos, logos, or brand assets are needed
- Icons or logos that must be authentic are required
- Reference images for real-world objects

After downloading, rename to `{name}_{width}x{height}.png` and save to `assets/`.

***

## Verify Assets Before Proceeding

```bash
# Confirm all assets exist with dimensions in filename
ls -la assets/*_*x*.png assets/*_*x*.jpg 2>/dev/null

# Verify dimensions match filename
for f in assets/*_*x*.png; do
  echo "$f: $(file "$f" | grep -oE '[0-9]+ x [0-9]+')"
done
```

**Only proceed to HTML code after:**

- [ ] All `[External]` / `[GenerateImage]` assets from the plan are generated
- [ ] Asset files exist with `{name}_{width}x{height}.png` naming
- [ ] Filename dimensions match actual image dimensions
