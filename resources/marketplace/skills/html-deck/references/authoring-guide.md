# Authoring Guide — presentation

Complete step-by-step walkthrough: from user request to finished deck.

## Before anything: understand the request

Before writing any code, gather:

1. **Topic & content.** What's the deck about?
2. **Audience.** Engineers? Execs? VC? 小红书读者? Students?
3. **Occasion.** Internal sharing? Conference? Pitch? Report?
4. **Language.** Chinese? English? Mixed?
5. **Tone.** Formal, casual, playful, dark-tech, editorial?
6. **Deliverable.** HTML only? Also PNG?

⛔ **NEVER ask the user how many slides they want.** Slide count is driven by content density, not user preference.

## Step 1: Plan Content → plan.md

Write a `plan.md` with three sections:

### 1A. Narrative Arc

A numbered table where every row = one slide. Include **Layout** (template file) and **Animation** (entry effect) so that design decisions are locked during planning.

```
| # | Title | Role | Content Summary | Visual | Layout | Animation |
|---|---|---|---|---|---|---|
| 1 | Welcome to presentation | Cover | Tagline + logo | [Built-in] | cover | blur-in |
| 2 | What We'll Cover | TOC | 4 topics | [Built-in] | toc | stagger-list |
| 3 | The Problem | Section | Pain points | [Built-in] | section-divider | rise-in |
| 4 | Scale Challenges | Body | 3 stats + chart | [ECharts:chart-bar-echarts] | chart-bar-echarts | fade-up |
| 5 | Architecture | Body | 3-tier diagram | [Built-in] | arch-diagram | path-draw |
| ... | | | | | | |
| N | Thank You | Closing | Contact + QR | [Built-in] | thanks | confetti-burst |
```

**Layout** column — file name from `templates/single-page/` (without `.html`). Quick reference:

| Slide role | Recommended layouts |
|---|---|
| Cover | `cover` |
| TOC | `toc` |
| Section divider | `section-divider` |
| Bullets / text | `bullets`, `two-column`, `three-column` |
| Quote | `big-quote` |
| Stats / KPIs | `stat-highlight`, `kpi-grid` |
| Data chart | `chart-bar-echarts`, `chart-line-echarts`, `chart-pie-echarts`, `chart-radar-echarts` |
| Advanced chart | `chart-sankey`, `chart-heatmap`, `chart-tree`, `chart-graph` |
| Table | `table` |
| Code | `code`, `diff`, `terminal` |
| Flow / arch | `flow-diagram`, `arch-diagram`, `mindmap` |
| Process | `process-steps` |
| Timeline | `timeline-horizontal`, `timeline-vertical`, `roadmap`, `gantt` |
| Comparison | `comparison`, `pros-cons` |
| Image | `image-hero`, `image-grid` |
| CTA / Closing | `cta`, `thanks` |

See [layouts.md](layouts.md) for full descriptions.

**Animation** column — a CSS animation name (`data-anim`) or Canvas FX name (`data-fx`). Use `—` if no animation is needed. Quick reference:

| Category | Names |
|---|---|
| Directional fades | `fade-up`, `fade-down`, `fade-left`, `fade-right` |
| Dramatic entries | `rise-in`, `drop-in`, `zoom-pop`, `blur-in`, `glitch-in` |
| Text effects | `typewriter`, `neon-glow`, `shimmer-sweep`, `gradient-flow` |
| Lists & numbers | `stagger-list`, `counter-up` |
| SVG / geometry | `path-draw`, `morph-shape` |
| 3D | `parallax-tilt`, `card-flip-3d`, `cube-rotate-3d`, `page-turn-3d`, `perspective-zoom` |
| Ambient | `marquee-scroll`, `kenburns`, `confetti-burst`, `spotlight`, `ripple-reveal` |
| Canvas FX | `particle-burst`, `confetti-cannon`, `firework`, `starfield`, `matrix-rain`, `knowledge-graph`, `neural-net`, `constellation`, `galaxy-swirl`, etc. |

See [animations.md](animations.md) for full descriptions.

Rules:
- **One core message per slide.** If you cannot summarize in one sentence → split.
- **Fixed overhead:** Cover (1) + TOC (1) + Closing (1) = minimum 3 slides before body content.
- **Reading only the titles should tell the whole story** (narrative arc test).
- Section dividers are optional but recommended for 6+ body slides.
- **Max 1–2 animations per slide.** Prefer `fade-up` as a safe default; use dramatic/FX sparingly.

### 1B. Visual Elements Inventory

List every visual asset with a **specific** source tag. For charts, specify the exact template; for images, specify the generation method. This section is **asset-level, not slide-level**: one row = one concrete asset or asset slot. If a slide contains multiple visuals, repeat the slide number with suffixes like `6a`, `6b`, `6c`. Use `[none]` only for slides that truly have no visual asset (pure text / bullets).

| # | Visual | Tag | Notes |
|---|---|---|---|
| 1 | — | `[none]` | Cover — text only |
| 2 | — | `[none]` | TOC — text only |
| 3 | Hero illustration | `[GenerateImage]` | Abstract shapes, warm tones, 1920×1080 |
| 4 | Revenue bar chart | `[ECharts:chart-bar-echarts]` | Q1–Q4 revenue data |
| 5 | Architecture diagram | `[Built-in]` | 3-layer microservice, use arch-diagram layout |
| 6a | Team member portrait — CEO | `[GenerateImage]` | 1:1, editorial portrait |
| 6b | Team member portrait — CTO | `[GenerateImage]` | 1:1, editorial portrait |
| 6c | Team member portrait — COO | `[GenerateImage]` | 1:1, editorial portrait |
| 7 | User flow sankey | `[ECharts:chart-sankey]` | Signup → Activation funnel |
| 8 | Team photo | `[External]` | From company assets |
| N | — | `[none]` | Closing — text only |

Tags — be specific:
- `[none]` — no visual asset needed (text-only slides like Cover, TOC, Section Divider, Closing)
- `[Built-in]` — template shapes, CSS-only graphics, icons via text/emoji
- `[ECharts:<template>]` — specify the exact ECharts template: `chart-bar-echarts`, `chart-line-echarts`, `chart-pie-echarts`, `chart-radar-echarts`, `chart-sankey`, `chart-heatmap`, `chart-tree`, `chart-graph`
- `[GenerateImage]` — AI-generated images (recommended for illustrations/backgrounds/hero)
- `[External]` — stock photos, logos, downloaded assets

Rules:
- **Do not collapse multiple assets on the same slide into one row.** A 3-card image slide needs 3 inventory rows.
- **Match asset count to layout slots.** `image-caption-card` usually needs 3 images; `image-grid` can need up to 7; `image-text-split` usually needs 1.
- **Only use `[none]` when the slide is genuinely text-only or built entirely from built-in shapes/icons.**

## Step 2: Choose Theme

Match audience × tone to a theme from `themes.md`:

| Audience | Tone | Recommended Themes |
|---|---|---|
| Engineers | Dark, techy | `catppuccin-mocha`, `tokyo-night`, `dracula`, `gruvbox-dark` |
| Engineers | Blueprint, infra | `terminal-green`, `blueprint`, `engineering-whiteprint` |
| Designers / PM | Elegant, editorial | `editorial-serif`, `soft-pastel`, `aurora` |
| Executives | Clean, corporate | `minimal-white`, `corporate-clean`, `swiss-grid` |
| VC / Investors | Bold, pitch | `pitch-deck-vc`, `neo-brutalism`, `bauhaus` |
| 小红书 / Consumers | Warm, lifestyle | `xiaohongshu-white`, `sunset-warm`, `soft-pastel`, `rainbow-gradient` |
| Students | Playful, pop | `memphis-pop`, `y2k-chrome`, `retro-tv` |
| Academic | Formal, paper | `academic-paper`, `editorial-serif`, `solarized-light` |
| Cyber / Launch | Neon, dramatic | `cyberpunk-neon`, `glassmorphism`, `vaporwave` |

Wire theme in HTML:

```html
<link rel="stylesheet" id="theme-link"
      href="../assets/themes/tokyo-night.css">
```

Set `data-themes` on `<body>` for T-key cycling:

```html
<body data-themes="tokyo-night,dracula,catppuccin-mocha,nord">
```

### Aesthetic direction

Design each deck as a **specific visual world**, not a generic AI-generated slide theme.

- **Create atmosphere and depth.** Use contextual textures and effects such as gradient meshes, SVG noise, geometric patterns, layered transparencies, dramatic shadows, decorative borders, grain overlays, or custom cursors when they strengthen the concept.
- **Avoid generic AI aesthetics.** Do not default to overused font families (`Inter`, `Roboto`, `Arial`, generic system UI stacks), cliched purple-on-white gradients, predictable SaaS card patterns, or context-free layouts.
- **Interpret creatively.** Make unexpected but coherent choices that feel intentionally designed for the topic, audience, and tone.
- **Vary the design language across generations.** Explore different light/dark directions, typography pairings, textures, and compositional rhythms; do not keep converging on the same familiar defaults such as `Space Grotesk`.
- **Match implementation complexity to the vision.** Maximalist decks need richer code, layering, and motion systems; minimalist decks need restraint, precision, and careful spacing/typography.

## Step 3: Prepare Assets

See [image-generation.md](image-generation.md) for detailed guidance.

**Workflow:**

1. `mkdir -p assets` — ensure directory exists
2. For `[GenerateImage]` items → each inventory row becomes one generated file; save as `assets/{name}_{w}x{h}.png`
3. For `[ECharts]` items → no pre-generation needed; will use templates in Step 4
4. For `[External]` items → download, rename, save to `assets/`
5. Verify all assets exist: `ls assets/*_*x*.png`

## Step 4: Scaffold & Build

### 4A. Scaffold

```bash
bash ./scripts/new-deck.sh my-talk <workspace-dir>
```

This creates `<workspace-dir>/my-talk/` with:
```
my-talk/
├── my-talk.html          ← product HTML (references ./_shared/ and ./assets/)
├── assets/               ← generated images, chart JS
└── _shared/              ← minimal shared assets (pre-populated)
```

### 4B. Choose layouts per slide

For each slide in plan.md, pick from `templates/single-page/`:

| Plan role | Recommended layout |
|---|---|
| Cover | `cover.html` |
| TOC | `toc.html` |
| Section divider | `section-divider.html` |
| Bullets / text | `bullets.html`, `two-column.html`, `three-column.html` |
| Big quote | `big-quote.html` |
| Stats / KPIs | `stat-highlight.html`, `kpi-grid.html` |
| Data chart (static) | `chart-bar.html`, `chart-line.html`, `chart-pie.html`, `chart-radar.html` |
| Data chart (interactive) | `chart-bar-echarts.html`, `chart-line-echarts.html`, `chart-pie-echarts.html`, `chart-radar-echarts.html` |
| Sankey / heatmap / tree / graph | `chart-sankey.html`, `chart-heatmap.html`, `chart-tree.html`, `chart-graph.html` |
| Table | `table.html` |
| Code | `code.html`, `diff.html`, `terminal.html` |
| Flow / architecture | `flow-diagram.html`, `arch-diagram.html` |
| Process | `process-steps.html` |
| Mindmap | `mindmap.html` |
| Timeline | `timeline-horizontal.html`, `timeline-vertical.html`, `roadmap.html`, `gantt.html` |
| Comparison | `comparison.html`, `pros-cons.html` |
| Images | `image-hero.html`, `image-grid.html`, `image-text-split.html`, `image-caption-card.html`, `image-fullbleed.html` |
| CTA | `cta.html` |
| Closing | `thanks.html` |

### 4C. Author slides

1. Copy `<section class="slide">…</section>` from the layout template
2. Paste into your deck's `<name>.html`
3. Replace demo data with real content
4. For ECharts slides: copy the whole `<section>` + `<script>` block, update data
5. Add `data-anim="fade-up"` sparingly (1–2 animations per slide max)
6. Add `<div class="notes">…</div>` for speaker notes

### 4D. ECharts chart authoring

All ECharts templates follow the same pattern:

```html
<script src="./_shared/echarts.min.js"></script>
<script src="./_shared/echarts-theme-sync.js"></script>
<script>
document.addEventListener('DOMContentLoaded', function() {
  var container = document.getElementById('my-chart');
  var chart = echarts.init(container, null, { renderer: 'svg' });
  var c = window.__deckECharts.readThemeColors();

  function getOption(c) {
    return {
      color: [c.accent, c.accent2, c.accent3],
      // ... chart-specific option using c.text2, c.border, etc.
    };
  }

  chart.setOption(getOption(c));
  window.__deckECharts.register(chart, getOption);
  new ResizeObserver(function() { chart.resize(); }).observe(container);
});
</script>
```

Key rules:
- **Always `renderer: 'svg'`** — ensures crisp vector output
- **Always register to theme sync** — required for T-key theme cycling
- **Never hardcode colors** — always read from `readThemeColors()`

## Step 5: Deliver

**Do NOT preview or validate.** The model must NOT start a local server, open the HTML in a browser, or run any verification step. The deck is built directly in the user's workspace — no separate deploy or bundle step is needed.

After completing the HTML, inform the user of:
- **Folder location:** `<workspace-dir>/<name>/`
- **Entry file:** `<name>.html`
- **Keyboard controls:** `→`/`Space`/`Enter` = next, `←` = prev, `F`/`F11` = fullscreen
- **Recommend fullscreen** for best experience

## Naming conventions

| Scope | Convention |
|---|---|
| Deck folder | `<workspace-dir>/my-talk/` — kebab-case |
| Asset files | `assets/{name}_{w}x{h}.png` — snake_case with dimensions |
| CSS classes | Reuse from `base.css` — `.h1`, `.card`, `.grid.g2`, `.pill` |
| Slide titles | `data-deck-label="Slide Title"` on `<section>` |

## Common pitfalls

| Problem | Fix |
|---|---|
| Colors don't match theme | Use `var(--text-1)`, not `#111` |
| ECharts not updating on theme switch | Register via `window.__deckECharts.register()` |
| Text overflows slide | Reduce content; one message per slide |
| Animation too busy | Max 1-2 `data-anim` per slide |
| Charts look blurry | Use `renderer: 'svg'`, not default canvas |
| Edit mode conflicts with navigation | Press E to exit edit before navigating |

## File structure of a finished deck

The scaffold (`new-deck.sh`) creates a self-contained deck directly in the workspace:
```
<workspace-dir>/my-talk/
├── my-talk.html     ← main deck (references ./_shared/)
├── assets/
│   ├── hero_1920x1080.png
│   ├── arch_800x600.png
│   └── logo_200x200.png
└── _shared/
    ├── base.css
    ├── fonts.css
    ├── decorations.css
    ├── runtime.js
    ├── echarts.min.js
    ├── echarts-theme-sync.js
    ├── themes/        ← copy needed theme CSS here
    └── animations/    ← animations.css + fx-runtime.js + fx/
```

`my-talk.html` references shared assets via `./_shared/`:
```html
<link href="./_shared/fonts.css" rel="stylesheet">
<link href="./_shared/base.css" rel="stylesheet">
<link href="./_shared/themes/tokyo-night.css" rel="stylesheet" id="theme-link">
<link href="./_shared/animations/animations.css" rel="stylesheet">
<script src="./_shared/runtime.js"></script>
<script src="./_shared/echarts-theme-sync.js"></script>
```
