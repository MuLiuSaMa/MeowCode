---
name: html-deck
description: Create stunning, animation-rich HTML slide decks from scratch. Outputs a self-contained HTML file that opens in any browser, agent-friendly, visually impressive and pixel-perfect across all platforms. Use when the user says "演示文稿", "presentation", "slides", or "deck" WITHOUT explicitly mentioning "PPT" or "ppt" — if the user says "PPT"/"ppt", route to the `pptx` skill instead. Covers building a brand-new presentation from a topic, outline, document, or Markdown — i.e. no existing .pptx file is involved. The deliverable is always HTML.
---

## Step-by-step execution and dependencies

1. Follow this Skill's workflow in order. Before a step uses a library, command-line tool, runtime, or font, check only the dependencies required by that step; do not assume they are installed.
2. Reuse dependencies that are available. If one is missing, install only that dependency using the current OS and an available package manager, then verify it and retry the original step. Do not install the entire dependency list in advance.
3. Use the active Python environment (`python -m pip install <package>`, or the matching `python3`); create a task-local virtual environment if needed. Install Node.js libraries in the task project (`npm install <package>`) so the script can resolve them. For system tools and fonts, use the available OS package manager (for example, Homebrew on macOS, apt on Debian/Ubuntu, or winget on Windows).
4. Follow the host's permission flow when installation needs approval. If the package manager or required permission is unavailable, or installation/download fails, report the missing dependency and affected step; do not retry indefinitely or claim the step passed. Continue independent steps when possible.
5. Keep the original workflow and quality checks. Check fonts only when rendering requires them. Steps using only text, built-in tools, or self-contained HTML require no package installation; external tool access or authentication must be handled through the host, not a package manager.

## Workflow — 5 steps

**Do not start writing slides until you complete steps 1-3.**

### Step 1: Plan Content

**You MUST think through all the planning questions below before writing any HTML.** Writing a `plan.md` file is optional for short/simple decks — you may keep the plan in your reasoning instead of creating a file. For long, complex decks (8+ content slides or involving multiple generated images/charts), you SHOULD create a `plan.md` file in your temporary work directory to maintain consistency. Regardless of whether you write it down, every field below MUST be considered and decided upon. The plan drives all subsequent steps. **If a `plan.md` is written, it is an intermediate planning artifact only — it must NOT appear in the final deliverables presented to the user.**


#### 📖 Load Best Practice Reference

Before planning, identify the presentation type and load the matching best-practice guide. **Use the full path including the category subdirectory** when reading:

| # | Type | Path |
|---|---|---|
| 01 | Pitch Deck | `references/slide_best_practices/01_startup_funding/01_pitch_deck.md` |
| 02 | Elevator Pitch | `references/slide_best_practices/01_startup_funding/02_elevator_pitch.md` |
| 03 | Business Plan | `references/slide_best_practices/01_startup_funding/03_business_plan.md` |
| 04 | Investor Update | `references/slide_best_practices/01_startup_funding/04_investor_update.md` |
| 05 | Quarterly Business Review | `references/slide_best_practices/02_corporate_management/05_quarterly_business_review.md` |
| 06 | All-Hands Meeting | `references/slide_best_practices/02_corporate_management/06_all_hands_meeting.md` |
| 07 | Project Kickoff | `references/slide_best_practices/02_corporate_management/07_project_kickoff.md` |
| 08 | Post-Mortem | `references/slide_best_practices/02_corporate_management/08_post_mortem.md` |
| 09 | Onboarding | `references/slide_best_practices/02_corporate_management/09_onboarding.md` |
| 10 | Change Management | `references/slide_best_practices/02_corporate_management/10_change_management.md` |
| 11 | Sales Deck | `references/slide_best_practices/03_sales_marketing/11_sales_deck.md` |
| 12 | Product Launch | `references/slide_best_practices/03_sales_marketing/12_product_launch.md` |
| 13 | Company Profile | `references/slide_best_practices/03_sales_marketing/13_company_profile.md` |
| 14 | Case Study | `references/slide_best_practices/03_sales_marketing/14_case_study.md` |
| 15 | Media Kit | `references/slide_best_practices/03_sales_marketing/15_media_kit.md` |
| 16 | Brand Guidelines | `references/slide_best_practices/03_sales_marketing/16_brand_guidelines.md` |
| 17 | Thesis Defense | `references/slide_best_practices/04_academic_education/17_thesis_defense.md` |
| 18 | Lecture | `references/slide_best_practices/04_academic_education/18_lecture.md` |
| 19 | Research Poster | `references/slide_best_practices/04_academic_education/19_research_poster.md` |
| 20 | Book Review | `references/slide_best_practices/04_academic_education/20_book_review.md` |
| 21 | Workshop | `references/slide_best_practices/04_academic_education/21_workshop.md` |
| 22 | Market Analysis | `references/slide_best_practices/05_consulting_strategy/22_market_analysis.md` |
| 23 | Strategic Plan | `references/slide_best_practices/05_consulting_strategy/23_strategic_plan.md` |
| 24 | Consulting Proposal | `references/slide_best_practices/05_consulting_strategy/24_consulting_proposal.md` |
| 25 | Persona Analysis | `references/slide_best_practices/05_consulting_strategy/25_persona_analysis.md` |
| 26 | Portfolio | `references/slide_best_practices/06_personal_creative/26_portfolio.md` |
| 27 | Visual Resume | `references/slide_best_practices/06_personal_creative/27_visual_resume.md` |
| 28 | Travelogue | `references/slide_best_practices/06_personal_creative/28_travelogue.md` |
| 29 | Moodboard | `references/slide_best_practices/06_personal_creative/29_moodboard.md` |
| 30 | Event Speech | `references/slide_best_practices/06_personal_creative/30_event_speech.md` |
| 31 | Self-Introduction | `references/slide_best_practices/06_personal_creative/31_self_introduction.md` |
| 32 | Webinar | `references/slide_best_practices/06_personal_creative/32_webinar.md` |

**How to use**: Read the matched guide to adopt its **narrative structure**, **slide role sequence**, **language style & tone**, and **content depth per slide**. If the user's request doesn't map to a single type, blend the closest 2 guides.

The plan consists of two sections:

#### 1A. Narrative Arc

A numbered table — every row = one slide. Lock Layout + Animation at planning time.

```
| # | Title | Role | Content Summary | Visual | Layout | Animation | Decoration |
|---|---|---|---|---|---|---|---|
| 1 | Welcome to presentation | Cover | Tagline + logo | [Built-in] | cover | blur-in | deco-soft-gradient |
| 2 | What We'll Cover | TOC | 4 topics | [Built-in] | toc | stagger-list | — |
| 3 | The Problem | Section | Chapter divider | [Built-in] | section-divider | rise-in | deco-ambient-purple |
| 4 | Scale Challenges | Body | 3 stats + chart | [ECharts:chart-bar-echarts] | chart-bar-echarts | fade-up | deco-grid |
| 5 | Our Solution | Section | Chapter divider | [Built-in] | section-divider | rise-in | deco-ambient-purple |
| 6 | Architecture | Body | 3-tier diagram | [Built-in] | arch-diagram | path-draw | deco-scanlines |
| ... | | | | | | | |
| N | Thank You | Closing | Contact + QR | [Built-in] | thanks | confetti-burst | — |
```

`Visual` is a slide-level summary. If a slide contains multiple assets, say so explicitly, e.g. `[GenerateImage ×3]`, `[External ×4]`, or `Lead portrait + 2 product shots`.

**Layout** — file name from `templates/single-page/` (without `.html`):

| Slide role      | Recommended layouts                                                                     |
| --------------- | --------------------------------------------------------------------------------------- |
| Cover           | `cover`                                                                                 |
| TOC             | `toc`                                                                                   |
| Section divider | `section-divider`                                                                       |
| Bullets / text  | `bullets`, `two-column`, `three-column`                                                 |
| Quote           | `big-quote`                                                                             |
| Stats / KPIs    | `stat-highlight`, `kpi-grid`                                                            |
| Data chart      | `chart-bar-echarts`, `chart-line-echarts`, `chart-pie-echarts`, `chart-radar-echarts`   |
| Advanced chart  | `chart-sankey`, `chart-heatmap`, `chart-tree`, `chart-graph`                            |
| Table           | `table`                                                                                 |
| Code            | `code`, `diff`, `terminal`, `cyber-trace`                                               |
| Flow / arch     | `flow-diagram`, `arch-diagram`, `mindmap`                                               |
| Process         | `process-steps`                                                                         |
| Timeline        | `timeline-horizontal`, `timeline-vertical`, `roadmap`, `gantt`                          |
| Comparison      | `comparison`, `pros-cons`                                                               |
| Image           | `image-hero`, `image-grid`, `image-text-split`, `image-caption-card`, `image-fullbleed` |
| Alert / Callout | `alert-callout`                                                                         |
| Feature grid    | `glass-cards` (dark), `macaron-grid` (light)                                            |
| CTA / Closing   | `cta`, `thanks`                                                                         |

**Animation** — CSS animation (`data-anim`) or Canvas FX (`data-fx`). Use `—` if none needed:

| Category          | Names                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Directional fades | `fade-up`, `fade-down`, `fade-left`, `fade-right`                                                                                                   |
| Dramatic entries  | `rise-in`, `drop-in`, `zoom-pop`, `blur-in`, `glitch-in`                                                                                            |
| Text effects      | `typewriter`, `neon-glow`, `shimmer-sweep`, `gradient-flow`                                                                                         |
| Lists & numbers   | `stagger-list`, `counter-up`                                                                                                                        |
| SVG / geometry    | `path-draw`, `morph-shape`                                                                                                                          |
| 3D                | `parallax-tilt`, `card-flip-3d`, `cube-rotate-3d`, `page-turn-3d`, `perspective-zoom`                                                               |
| Ambient           | `marquee-scroll`, `kenburns`, `confetti-burst`, `spotlight`, `ripple-reveal`                                                                        |
| Canvas FX         | `particle-burst`, `confetti-cannon`, `firework`, `starfield`, `matrix-rain`, `knowledge-graph`, `neural-net`, `constellation`, `galaxy-swirl`, etc. |

**Decoration** — persistent atmosphere effects (`deco-*` class on `.slide`). Unlike animations (play once), decorations remain visible. Wire via `<link href="../assets/decorations.css">`:

| Category      | Names                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| Overlays      | `deco-scanlines`, `deco-grid`, `deco-rainbow-bar`, `deco-danger-stripe`, `deco-danger-stripe-bottom` |
| Ambient light | `deco-ambient-purple`, `deco-orbs`, `deco-blob`, `deco-soft-gradient`                                |
| Surface       | `deco-glass-surface`, `deco-glow-text`                                                               |

Use `—` if no decoration needed. Multiple effects can stack with `+` (e.g. `deco-scanlines + deco-grid`). If **any** slide uses decorations, add `<link href="./_shared/decorations.css">` to `<head>`. See [references/decorations.md](references/decorations.md) for pseudo-element conflicts and combo suggestions.

Rules:

- **One core message per slide.** If you cannot summarize in one sentence, split it.
- **Fixed overhead:** Cover (1) + TOC (1) + Closing (1) = 3 slides minimum before content.
- **Cover slide must be minimal.** Only: title, subtitle (optional), speaker name (optional), date (optional). Do NOT add stats cards, KPI numbers, feature lists, or any other information blocks. The cover exists solely to set the tone and introduce the topic.
- **Closing slide must be minimal.** Only: a short closing phrase (e.g. "Thank You", "谢谢") and optionally one brief sentence summarizing the deck's message. Do NOT add cards, feature grids, bullet lists, CTA buttons, or any substantive content. The closing exists solely to signal the end.
- **Section dividers are mandatory for 6+ body slides.** Preceding each major chapter/topic with a `section-divider` slide helps the audience follow the narrative structure. Plan dividers into the Narrative Arc table — they count toward total slide count.
- Reading only the titles should tell the whole story.
- Max 1–2 animations per slide. Prefer `fade-up` as safe default; use dramatic/FX sparingly.

#### 1B. Visual Elements Inventory

List every visual asset with a **specific** tag. This section is **asset-level, not slide-level**: one row = one concrete asset or asset slot. If one slide contains multiple visuals, repeat the slide number with suffixes like `6a`, `6b`, `6c`. Use `[none]` only for slides that truly have no visual asset at all.

<br />

```
| # | Visual | Tag | Notes |
|---|---|---|---|
| 1 | — | [none] | Cover — text only |
| 3 | Hero illustration | [GenerateImage] | Abstract shapes, 1920×1080 |
| 4 | Revenue bar chart | [ECharts:chart-bar-echarts] | Q1–Q4 data |
| 5 | Architecture diagram | [Built-in] | 3-layer microservice, use arch-diagram layout |
| 6a | Card 1: customer interview portrait | [GenerateImage] | 4:3, natural indoor lighting |
| 6b | Card 2: product usage close-up | [GenerateImage] | 4:3, clean desk scene |
| 6c | Card 3: team workshop moment | [GenerateImage] | 4:3, collaborative office setting |
| 7 | User flow sankey | [ECharts:chart-sankey] | Signup → Activation |
| N | — | [none] | Closing — text only |
```

Tags:

- `[none]` — no visual (text-only slides)
- `[Built-in]` — CSS-only graphics, icons, emoji
- `[ECharts:<template>]` — exact template name: `chart-bar-echarts`, `chart-line-echarts`, `chart-pie-echarts`, `chart-radar-echarts`, `chart-sankey`, `chart-heatmap`, `chart-tree`, `chart-graph`
- `[GenerateImage]` — AI-generated illustrations/backgrounds (recommended)
- `[External]` — stock photos, logos, downloaded assets

Rules:

- **Do not collapse multiple assets on the same slide into one row.** A 3-card image slide needs 3 inventory rows.
- **Match asset count to layout slots.** `image-caption-card` usually needs 3 images; `image-grid` can need up to 7; `image-text-split` usually needs 1.
- **Only use** **`[none]`** **when the slide is genuinely text-only or built entirely from built-in shapes/icons.**

### Step 2: Choose Theme

Use `references/themes.md`. When in doubt:

- **Engineers** → `catppuccin-mocha` / `tokyo-night` / `dracula` / `indigo-code`
- **Designers / product** → `editorial-serif` / `aurora` / `soft-pastel` / `fuchsia-cyan`
- **Execs** → `minimal-white` / `corporate-clean` / `swiss-grid` / `navy-formal`
- **Consumers** → `xiaohongshu-white` / `sunset-warm` / `soft-pastel`
- **Cyber / CLI / infra** → `terminal-green` / `blueprint` / `gruvbox-dark`
- **Pitch / bold** → `neo-brutalism` / `pitch-deck-vc` / `bauhaus` / `indigo-mint`
- **Launch / product reveal** → `glassmorphism` / `aurora`
- **Academic** → `academic-paper` / `editorial-serif` / `scholar-teal`
- **Party / government** → `crimson-gold` / `crimson-night`
- **Training / edu** → `navy-formal` / `scholar-teal` / `alert-crimson` / `indigo-code`
- **Finance / data** → `ledger-dark` / `amber-purple` / `arctic-cool`
- **Luxury / brand** → `luxury-noir` / `warm-cafe` / `japanese-minimal`
- **Nature / eco** → `forest-gold` / `clean-teal`

Wire as `<link id="theme-link" href="./_shared/themes/NAME.css">` and list 3-5 alternatives in `data-themes`.

#### Aesthetic Direction

Design each deck as a **specific visual world**, not a generic AI-generated slide theme.

- **Create atmosphere and depth.** Don't default to flat solid-color backgrounds when the concept calls for more. Use contextual textures and effects such as gradient meshes, SVG noise, geometric patterns, layered transparencies, dramatic shadows, decorative borders, grain overlays, or custom cursors when they strengthen the concept.
- **Avoid generic AI aesthetics.** Do not fall back to overused font families (`Inter`, `Roboto`, `Arial`, generic system UI stacks), cliched color recipes (especially purple gradients on white), predictable SaaS blocks, or cookie-cutter card grids that ignore the topic's context.
- **Interpret creatively.** Make unexpected but coherent choices that feel designed for the subject matter, audience, and tone. No two decks should converge on the same aesthetic by default.
- **Vary the design language across generations.** Deliberately explore different light/dark directions, typography pairings, textures, framing devices, and visual rhythms. Do not repeatedly converge on the same familiar choices such as `Space Grotesk`.
- **Match implementation complexity to the vision.** Maximalist directions should earn their richness with more elaborate code, layering, and motion. Minimalist or refined directions should earn their elegance through restraint, spacing, typography, and subtle details.

#### Background Texture (`--bg-texture`)

Every `.slide` supports a `--bg-texture` CSS variable that layers a subtle texture/gradient **above** the solid `--bg` color. Many themes ship a default texture (radial glows, SVG noise, etc.); slides that don't set it fall back to `none` (plain color, same as before).

- **Per-slide override** — use inline `style` to change or disable texture on a single slide:
  ```html
  <!-- disable texture on this slide -->
  <section class="slide" style="--bg-texture: none;">
  <!-- custom gradient on this slide only -->
  <section class="slide" style="--bg-texture: radial-gradient(circle at 50% 50%, rgba(255,100,50,.1), transparent 60%);">
  ```
- **AI-generated background image** — for hero/statement slides, use the `image-fullbleed` layout template which provides a full-screen background image + dark overlay for text readability. Reference the generated image from `assets/`:
  ```html
  <!-- image-fullbleed template: full-screen bg + overlay -->
  <section class="slide" style="background: linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.55)), url('assets/cityscape_1024x576.png') center/cover;">
  ```

### Step 3: Image Acquisition

Use images **deliberately** — not every slide needs one. Refer to the Visual Elements Inventory (Step 1B) for which specific assets need images. When an inventory row is tagged `[GenerateImage]`, **generate that asset directly with GenerateImage**.

#### Workflow

1. **Decide which inventory items need generated images** based on the Visual Elements Inventory. List only the `[GenerateImage]` rows, noting for each:
   - A descriptive prompt (what the image should depict)
   - Purpose: background, hero image, supporting illustration, or icon
   - Desired aspect ratio (16:9 for full-bleed backgrounds, 4:3 for content areas, 1:1 for headshots)
   - Target slide slot if needed (e.g. `6a left card`, `6b middle card`, `6c right card`)
2. **Generate images with GenerateImage** — call GenerateImage directly (no subagent needed). Generate each asset one by one, saving them to the deck's `assets/` directory:
   - Write a detailed, specific prompt for each image describing the desired scene, style, color tones, and mood.
   - Choose the right `image_size` for the target aspect ratio:
     - `landscape_16_9` (2560×1440) — full-slide backgrounds, wide layouts
     - `landscape_4_3` (2240×1680) — content area illustrations
     - `square` (1920×1920) — headshots, profile images, square icons
     - `portrait_4_3` (1680×2240) — portrait
     - `portrait_16_9` (1440×2560) — tall portrait
   - Save as `assets/{name}_{w}x{h}.png` (e.g. `assets/hero_16x9.png`)
   - **Never merge multiple** **`[GenerateImage]`** **rows from one slide into a single output file.**
3. **Use the file paths** in your slide HTML:
   ```html
   <img src="assets/hero_1024x576.png" alt="Hero illustration">
   ```

#### Prompt Tips for GenerateImage

- **Be specific about style**: "a modern flat illustration of…" or "a photorealistic aerial view of…"
- **Include color guidance**: "using warm tones of terracotta and sage green" to match the slide palette
- **Describe composition**: "left side shows X, right side shows Y, with negative space in the center for text overlay"
- **Specify mood**: "professional, clean, and minimal" vs "vibrant, energetic, and bold"
- **Avoid text in images**: Generated text is often garbled — use HTML text elements instead

#### Guidelines

- **Specify dimensions.** Always choose the right `image_size` for the target aspect ratio.
- **Save to the deck's** **`assets/`** **directory.** All images use `{name}_{w}x{h}.png` naming so they can be referenced by path and inlined correctly.
- **Match the deck's color palette.** Include the primary/accent colors in your GenerateImage prompt so images feel cohesive with the slides.
- **Prefer illustration style for consistency.** AI-generated photos can look uncanny — illustrations, abstract art, and stylized graphics tend to produce better results.

#### Other Asset Types

- **Data charts** — use ECharts templates (`templates/single-page/chart-*.html`), no need to pre-generate images

See [references/image-generation.md](references/image-generation.md) for detailed guidance on all asset types.

### Step 4: Build HTML

1. Scaffold the deck directory:

   **Linux / macOS:**
   ```bash
   bash ./scripts/new-deck.sh my-talk <workspace-dir>
   ```

   **Windows (native PowerShell):**
   ```powershell
   pwsh -File ./scripts/new-deck.ps1 my-talk <workspace-dir>
   ```

   This creates `<workspace-dir>/my-talk/` with:
   ```
   my-talk/
   ├── my-talk.html          ← product HTML (references ./_shared/ and ./assets/)
   ├── assets/               ← generated images, chart JS
   └── _shared/              ← minimal shared assets (pre-populated)
       ├── base.css
       ├── fonts.css
       ├── decorations.css
       ├── runtime.js
       ├── echarts.min.js
       ├── echarts-theme-sync.js
       ├── animations/
       │   ├── animations.css
       │   ├── fx-runtime.js
       │   └── fx/           ← copy needed fx scripts here
       └── themes/            ← copy needed theme CSS here
   ```

2. Copy the chosen theme into `_shared/themes/`:
   ```bash
   cp <skill-dir>/assets/themes/<theme>.css <workspace-dir>/my-talk/_shared/themes/
   ```
3. Pick layouts from `templates/single-page/` per slide in plan.md
4. Copy `<section class="slide" data-deck-label="...">…</section>` blocks, replace demo data
5. For charts, copy from ECharts templates (`chart-*-echarts.html`, `chart-sankey.html`, etc.)
   - In the generated deck, use `./_shared/echarts.min.js` and `./_shared/echarts-theme-sync.js` (NOT the `../../assets/` paths from template source files)
6. Add `data-anim` / `data-fx` animations sparingly; copy needed fx scripts:
   ```bash
   cp <skill-dir>/assets/animations/fx/<effect>.js <workspace-dir>/my-talk/_shared/animations/fx/
   ```
7. Add decorations: if plan.md has any `deco-*` entries, uncomment `<link href="./_shared/decorations.css">` in `<head>`, then add matching classes to each `<section class="slide deco-xxx">`
8. Add `<div class="notes">…</div>` for speaker notes
9. Place generated images and chart JS in `assets/`

⚠️ **Every HTML file must include the following meta tags in `<head>`:**
```html
<meta name="x-content-type" content="presentation" />
<meta name="x-presentation-version" content="1.0" />
<meta name="x-presentation-indicator" content="deck-stage .slide" />
```
The scaffold already includes these. If you create additional HTML files in the same deck folder, add all three meta tags to each one.

### Step 5: Deliver

**Do NOT preview or validate.** The model must NOT start a local server, open the HTML in a browser, or run any verification step. The deck is built directly in the user's workspace — no separate deploy step is needed.

After completing the HTML, inform the user of:
- **Folder location:** `<workspace-dir>/my-talk/`
- **Entry file:** `my-talk.html`
- **Keyboard controls:**
  - `→` / `Space` / `Enter`: Next slide
  - `←`: Previous slide
  - `F` or `F11`: Toggle fullscreen mode
- **Recommend fullscreen** for the best presentation experience


## Authoring rules (important)

- **Always start from a template.** Don't author slides from scratch.
- **Design for a distinctive aesthetic.** Make slides feel purpose-built for the topic, not like a generic AI deck.
- **Use tokens, not literal colors.** Good: `color: var(--text-1)`. Bad: `color: #111`.
- **Make backgrounds do real design work.** Use textures, overlays, shadows, borders, and atmospheric layers when they improve the concept; don't rely on plain fills by default.
- **Avoid default AI taste.** Skip overused font stacks, cliched purple-on-white gradients, and predictable SaaS-card layouts unless the brief explicitly demands them.
- **Vary themes and typography across decks.** Do not repeatedly converge on the same fonts, light/dark balance, or visual motifs.
- **Scale code complexity to the aesthetic.** Rich visual directions may require richer HTML/CSS/animation systems; restrained designs should show precision rather than emptiness.
- **ECharts always use SVG renderer.** `echarts.init(el, null, { renderer: 'svg' })` for crisp vector output.
- **Register ECharts to theme sync.** `window.__deckECharts.register(chart, getColorOption)` for T-key support.
- **Don't invent new layout files.** Prefer composing existing ones.
- **Keyboard-first.** Always include `<script src="./_shared/runtime.js"></script>`.
- **Wrap all slides in `<deck-stage width="1920" height="1080">`** — this is the deck boundary and canvas size declaration. Never use `<div class="deck">`.
- **One** **`.slide`** **per logical page.** `runtime.js` makes `.slide.active` visible.
- **Every `.slide` must have `data-deck-label`** — the page title for structural identification (e.g. `data-deck-label="项目进展"`).
- **Supply notes.** Wrap in `<div class="notes">…</div>` inside each slide.
- **NEVER put presenter-only text on the slide itself.** Use `.notes` div.
- **Use** **`deco-*`** **classes for atmosphere.** Don't inline atmosphere CSS — use `decorations.css` instead.
- **NEVER override** **`.slide`** **positioning.** `base.css` sets `.slide { position: absolute; opacity: 0 }` so `runtime.js` can show one page at a time via `.active`. Adding `position: relative` (or any override to `position`/`opacity`/`display` on `.slide`) in your `<style>` will break the slide system and cause all pages to stack visibly on one scroll. If you need layout tweaks, scope them to a child element inside `.slide`.
- **Use direct-child selectors for sizing in nested layouts.** When setting fixed `height`/`width` on `.card` (or any reusable class) inside a grid wrapper, always use `>` (e.g. `.my-grid > .card { height: 500px }`) to avoid accidentally sizing nested children. The base `.card` class is used at multiple nesting levels — a descendant selector like `.wrapper .card` will cascade into inner grids and cause layout overflow/misalignment.

## Writing guide

See [references/authoring-guide.md](references/authoring-guide.md) for the
step-by-step walkthrough.

## Catalogs (load when needed)

- [references/slide\_best\_practices/](references/slide_best_practices/) — 32 presentation-type best practices (narrative structure, language style, content depth). **Load in Step 1.**
- [references/themes.md](references/themes.md) — all 52 themes with when-to-use.
- [references/layouts.md](references/layouts.md) — all 56 layout types (48 original + 8 ECharts).
- [references/animations.md](references/animations.md) — 27 CSS + 20 canvas FX animations.
- [references/decorations.md](references/decorations.md) — 12 ambient decoration effects (`deco-*` classes).
- [references/presenter-mode.md](references/presenter-mode.md) — 演讲者模式 + 逐字稿编写指南.
- [references/image-generation.md](references/image-generation.md) — GenerateImage guide.
- [references/authoring-guide.md](references/authoring-guide.md) — full workflow.

## File structure

```
html-deck/
├── SKILL.md                 (this file)
├── references/              (detailed catalogs, load as needed)
├── assets/
│   ├── base.css             (tokens + primitives — do not edit per deck)
│   ├── fonts.css            (webfont imports)
│   ├── runtime.js           (keyboard + presenter + overview + theme cycle + edit mode)
│   ├── echarts.min.js       (ECharts 5.5.0 — local bundle, no CDN)
│   ├── echarts-theme-sync.js (ECharts ↔ CSS theme auto-sync)
│   ├── decorations.css      (12 ambient decoration effects)
│   ├── themes/*.css         (52 token overrides, one per theme)
│   └── animations/
│       ├── animations.css   (27 named CSS entry animations)
│       ├── fx-runtime.js    (auto-init [data-fx] on slide enter)
│       └── fx/*.js          (20 canvas FX modules)
├── templates/
│   ├── deck.html                  (minimal 6-slide starter — reference only)
│   ├── theme-showcase.html        (52 slides, iframe-isolated per theme)
│   ├── layout-showcase.html       (iframe tour of all layouts)
│   ├── animation-showcase.html    (FX + CSS animation slides)
│   └── single-page/*.html         (56 layout files — 48 original + 8 ECharts)
├── scripts/
│   ├── new-deck.sh                (scaffold a deck directory — Linux/macOS)
│   └── new-deck.ps1               (scaffold a deck directory — Windows native PowerShell)
```

### Deck output structure (created by new-deck.sh)

```
<workspace-dir>/<name>/
├── <name>.html          ← product HTML with x-content-type meta tags
├── assets/              ← generated images, chart JS
│   ├── *.png
│   └── *.js
└── _shared/
    ├── base.css
    ├── fonts.css
    ├── decorations.css
    ├── animations/
    │   ├── animations.css
    │   ├── fx-runtime.js
    │   └── fx/*.js
    ├── themes/
    │   └── *.css
    ├── runtime.js
    ├── echarts.min.js
    └── echarts-theme-sync.js
```


## License & author

MIT. Copyright (c) 2026.
