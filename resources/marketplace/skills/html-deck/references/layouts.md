# Layouts catalog

Every layout lives in `templates/single-page/<name>.html` as a fully
functional standalone page with realistic demo data. Open any file directly
in Chrome to see it working.

To compose a new deck: open the file, copy the `<section class="slide">…</section>`
block (or multiple blocks) into your deck HTML, and replace the demo data.
Shared CSS (base, theme, animations) is already wired by `deck.html`.

## Openers & transitions

| file                   | purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `cover.html`           | Deck cover. Kicker + huge title + lede + pill row.               |
| `toc.html`             | Table of contents. Grid of numbered cards; items freely addable. |
| `section-divider.html` | Big numbered section break (02 · Theme).                         |

## Text-centric

| file                | purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `bullets.html`      | Classic bullet list with card-wrapped items; items freely addable. |
| `two-column.html`   | Concept + example side by side.                                    |
| `three-column.html` | Equal pillars with icons; columns freely addable.                  |
| `big-quote.html`    | Full-bleed pull quote in editorial-serif style.                    |

## Numbers & data

| file                  | purpose                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `stat-highlight.html` | One giant number + subtitle (uses `.counter` animation).                                    |
| `kpi-grid.html`       | KPIs in a row with up/down deltas; items freely addable.                                    |
| `kpi-tower.html`      | Unequal-height KPI towers; `.h1`–`.h5` map data magnitude; `.accent` highlights key metric. |
| `stacked-ledger.html` | Row-style ledger KPIs: big number + label + icon per row; `.accent` highlights.             |
| `table.html`          | Data table with hover rows, right-aligned numerics; rows/cols freely addable.               |
| `chart-bar.html`      | Chart.js bar chart, theme-aware colors.                                                     |
| `chart-line.html`     | Chart.js dual-line chart with filled area.                                                  |
| `chart-pie.html`      | Chart.js doughnut + takeaways card.                                                         |
| `chart-radar.html`    | Chart.js radar comparing items on multiple axes.                                            |

## ECharts charts (interactive, SVG renderer)

| file                       | purpose                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `chart-bar-echarts.html`   | ECharts bar chart with theme sync. Drop-in replacement for `chart-bar.html`. |
| `chart-line-echarts.html`  | ECharts dual-line area chart with gradient fill.                             |
| `chart-pie-echarts.html`   | ECharts doughnut + takeaways card (same layout as `chart-pie.html`).         |
| `chart-radar-echarts.html` | ECharts radar comparing items on multiple axes.                              |
| `chart-sankey.html`        | Sankey diagram for flow / conversion funnel.                                 |
| `chart-heatmap.html`       | Heatmap for time × dimension matrix data.                                    |
| `chart-tree.html`          | Tree diagram for org charts / classification hierarchy.                      |
| `chart-graph.html`         | Force-directed graph for knowledge graph / dependency network.               |

All ECharts templates use **SVG renderer** (crisp vector output) and auto-sync colors when pressing T to cycle themes via `echarts-theme-sync.js`.

## Code & terminal

| file            | purpose                                                |
| --------------- | ------------------------------------------------------ |
| `code.html`     | Syntax-highlighted code via highlight.js (JS example). |
| `diff.html`     | Hand-rolled +/- diff view.                             |
| `terminal.html` | Terminal window mock with traffic-light header.        |

## Styled variants

| file                  | purpose                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `alert-callout.html`  | Color-coded alert / callout boxes (danger / warn / success); items freely addable.                                          |
| `glass-cards.html`    | Frosted-glass card grid with `backdrop-filter` blur — warm / blue / green tints; items freely addable. Best on dark themes. |
| `macaron-grid.html`   | Soft pastel-colored card grid (`.soft-*` colors); items freely addable. Best on light themes.                               |
| `matrix-grid.html`    | Dense tag-title-desc grid; JS auto-calculates rows×cols; `.accent` highlights key items.                                    |
| `platform-cards.html` | Channel/platform cards with big number + label; JS auto-rows; `.accent` highlights.                                         |
| `cyber-trace.html`    | Terminal-style code display with manual syntax highlighting (`.kw` / `.fn` / `.str` / `.cmt` spans). No CDN dependency.     |

## Diagrams & flows

| file                 | purpose                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `flow-diagram.html`  | Pipeline with arrows and highlighted node; nodes freely addable.                                        |
| `arch-diagram.html`  | Multi-tier architecture grid; rows/cols freely addable.                                                 |
| `process-steps.html` | Numbered steps in cards; items freely addable.                                                          |
| `mindmap.html`       | Radial mindmap with SVG path-draw animation.                                                            |
| `tech-spec.html`     | Left title + right KPI specs + bottom hero number; specs freely addable; `.accent` highlights key spec. |

## Plans & comparisons

| file                       | purpose                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `timeline-horizontal.html` | Horizontal timeline with dots; items freely addable.                                                    |
| `timeline-vertical.html`   | Vertical timeline with left rail; items freely addable; `.highlight` marks key nodes.                   |
| `roadmap.html`             | Multi-column roadmap (NOW / NEXT / LATER / …); columns freely addable.                                  |
| `gantt.html`               | Gantt chart with parallel tracks; rows and weeks freely addable.                                        |
| `comparison.html`          | Before vs After two-panel card.                                                                         |
| `image-compare.html`       | A/B dual-column comparison with image placeholders + bullet lists; `.accent` highlights preferred side. |
| `pros-cons.html`           | Pros and cons two-card layout; items freely addable.                                                    |
| `todo-checklist.html`      | Checklist with checked/unchecked states; items freely addable.                                          |

## Visuals

| file                      | purpose                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `image-hero.html`         | Full-bleed hero with Ken Burns gradient background.                                                    |
| `image-grid.html`         | Bento grid with gradient placeholders; cells freely addable, use `grid-column:span` for sizing.        |
| `image-text-split.html`   | 50/50 split — image left, text right (add `.reverse` for right-image).                                 |
| `image-caption-card.html` | Card grid with thumbnail + title + description; items freely addable.                                  |
| `image-fullbleed.html`    | Full-bleed background image with scrim overlay and centered text.                                      |
| `image-toc.html`          | Left TOC list + right hero image; items freely addable.                                                |
| `image-statement.html`    | Left image with text overlay + right numbered takeaways; items freely addable; `.accent` on last item. |
| `image-manifesto.html`    | Left big-title manifesto text + right image placeholder.                                               |
| `image-compare.html`      | (see Plans & comparisons)                                                                              |

## Closers

| file          | purpose                                              |
| ------------- | ---------------------------------------------------- |
| `cta.html`    | Call-to-action with big gradient headline + buttons. |
| `thanks.html` | Final "Thanks" page with confetti burst.             |

## Picking a layout

- **Opener**: `cover.html`, often followed by `toc.html` or `image-toc.html` (with hero image).
- **Section break**: `section-divider.html` before every major section.
- **Core content**: `bullets.html`, `two-column.html`, `three-column.html`.
- **Feature grid**: `glass-cards.html` (dark, frosted), `macaron-grid.html` (light, pastel), `matrix-grid.html` (dense), `platform-cards.html` (channel data).
- **Show numbers**: `stat-highlight.html` (single), `kpi-grid.html` (row), `kpi-tower.html` (magnitude bars), `stacked-ledger.html` (row-style).
- **Show plot**: `chart-bar.html` / `chart-line.html` / `chart-pie.html` / `chart-radar.html`.
- **Show data (interactive)**: `chart-bar-echarts.html` / `chart-line-echarts.html` / `chart-pie-echarts.html` / `chart-radar-echarts.html` — prefer ECharts versions for hover tooltips and theme sync.
- **Show flow/conversion**: `chart-sankey.html`.
- **Show matrix/density**: `chart-heatmap.html`.
- **Show hierarchy**: `chart-tree.html`.
- **Show relationships**: `chart-graph.html`.
- **Show a diff or change**: `comparison.html`, `diff.html`, `pros-cons.html`, `image-compare.html` (with images).
- **Alert / callout**: `alert-callout.html`.
- **Show a plan**: `timeline-horizontal.html`, `timeline-vertical.html`, `roadmap.html`, `gantt.html`, `process-steps.html`.
- **Show architecture / spec**: `arch-diagram.html`, `flow-diagram.html`, `mindmap.html`, `tech-spec.html`.
- **Code / demo**: `code.html`, `terminal.html`.
- **Code trace / CLI log**: `cyber-trace.html`.
- **Statement / manifesto**: `image-statement.html` (image + takeaways), `image-manifesto.html` (big title + image).
- **Closer**: `cta.html` → `thanks.html`.

## Naming / structure conventions

- Each slide is `<section class="slide" data-deck-label="...">`.
- Header pills: `<p class="kicker">…</p>`, eyebrow: `<p class="eyebrow">…</p>`.
- Titles: `<h1 class="h1">…</h1>` / `<h2 class="h2">…</h2>`.
- Lede: `<p class="lede">…</p>`.
- Cards: `<div class="card">…</div>` (variants: `card-soft`, `card-outline`, `card-accent`).
- Grids: `.grid.g2`, `.grid.g3`, `.grid.g4`.
- Notes: `<div class="notes">…</div>` per slide.

