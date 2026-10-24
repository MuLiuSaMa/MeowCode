# Decorations catalog

Ambient visual effects that persist on a slide (unlike animations, which play once on
entry). All decorations live in `assets/decorations.css`. Apply them by adding
`class="deco-<name>"` to any `.slide` element. Multiple decorations can stack.

## How decorations differ from animations

| | Animations (`data-anim`) | Decorations (`deco-*` class) |
|---|---|---|
| Trigger | Plays once when slide becomes active | Always visible while slide is active |
| Purpose | Entry transition / emphasis | Persistent visual atmosphere |
| Mechanism | CSS animation (keyframes) | Pseudo-elements / backdrop-filter |
| File | `assets/animations/animations.css` | `assets/decorations.css` |

## Overlays & textures

| class | effect | best on | source |
|---|---|---|---|
| `deco-scanlines` | CRT horizontal scan lines | Dark themes | hermes-cyber-terminal |
| `deco-grid` | Crosshatch grid with radial fade | Dark themes | hermes / obsidian |
| `deco-danger-stripe` | Top red/black 45° stripe (14px) | Any theme | testing-safety-alert |
| `deco-danger-stripe-bottom` | Bottom red/black stripe (6px) | Any theme | testing-safety-alert |
| `deco-rainbow-bar` | Top 10-color rainbow bar (5px) | Light themes | xhs-white-editorial |

## Ambient lighting

| class | effect | best on | source |
|---|---|---|---|
| `deco-ambient-purple` | Dual purple/blue radial glow | Dark themes | obsidian-claude-gradient |
| `deco-orbs` | 3 floating blurred color orbs | Dark themes | graphify-dark-graph |
| `deco-blob` | Single large blurred gradient circle | Any theme | pitch-deck |
| `deco-soft-gradient` | Full-slide soft pastel gradient | Light themes | pitch-deck |

## Surface effects

| class | effect | best on | source |
|---|---|---|---|
| `deco-glass-surface` | Frosted glass (backdrop-filter) | Dark themes | graphify-dark-graph |
| `deco-glow-text` | Neon text-shadow glow (apply to text elements, not .slide) | Dark themes | hermes-cyber-terminal |

## Pseudo-element allocation

Decorations use `::before` and `::after` pseudo-elements on `.slide`:

| Decoration | Uses |
|---|---|
| `deco-scanlines` | `::before` |
| `deco-grid` | `::after` |
| `deco-ambient-purple` | `::before` |
| `deco-blob` | `::before` |
| `deco-rainbow-bar` | `::before` |
| `deco-danger-stripe` | `::before` |
| `deco-danger-stripe-bottom` | `::after` |

**Conflict rule**: If two decorations share the same pseudo-element, only one will render.

Safe combos that use different pseudo-elements: `deco-scanlines` + `deco-grid`, `deco-danger-stripe` + `deco-danger-stripe-bottom`, `deco-rainbow-bar` + `deco-grid`.

## `deco-orbs` usage

Unlike other decorations, `deco-orbs` requires 3 child `<div>` elements:

```html
<section class="slide deco-orbs">
  <div class="deco-orb"></div>
  <div class="deco-orb"></div>
  <div class="deco-orb"></div>
  <!-- your slide content here -->
</section>
```

## CSS variable overrides

Several decorations accept custom properties for customization:

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `--grid-color` | `deco-grid` | `rgba(255,255,255,.08)` | Grid line color |
| `--grid-size` | `deco-grid` | `56px` | Grid cell size |
| `--blob-gradient` | `deco-blob` | `linear-gradient(135deg,#3b5bff,#7a46ff 55%,#d94cff)` | Blob gradient |
| `--stripe-fg` | `deco-danger-stripe*` | `#e0314a` | Stripe foreground color |
| `--stripe-bg` | `deco-danger-stripe*` | `#111318` | Stripe background color |
| `--grad-soft` | `deco-soft-gradient` | `linear-gradient(135deg,#eef1ff,#f4edff 55%,#fbedff)` | Gradient definition |
| `--accent` | `deco-glow-text` | `#7ed3a4` | Glow color |

## Suggested combos

| Vibe | Decorations | Theme suggestion |
|---|---|---|
| Cyber / terminal | `deco-scanlines` + `deco-grid` | `terminal-green`, `tokyo-night` |
| Deep space | `deco-orbs` | `dracula`, `catppuccin-mocha` |
| Glass lab | `deco-glass-surface` + `deco-ambient-purple` | `tokyo-night`, `glassmorphism` |
| VC pitch | `deco-blob` + `deco-soft-gradient` | `minimal-white`, `pitch-deck-vc` |
| Safety alert | `deco-danger-stripe` + `deco-danger-stripe-bottom` | `minimal-white`, `neo-brutalism` |
| Magazine | `deco-rainbow-bar` | `editorial-serif`, `xiaohongshu-white` |

## Background texture (`--bg-texture`)

Independent of decorations, every `.slide` supports a **background texture layer** via the `--bg-texture` CSS variable (defined in `base.css`). This renders as the topmost `background-image` layer, above the solid `--bg` color.

### How it works

```css
/* base.css */
.slide {
  background: var(--bg-texture, none), var(--bg);
}
```

Themes can set `--bg-texture` in their `:root` block. If unset, it defaults to `none` (pure `--bg` color, no change from before).

### Themes with built-in textures

| Theme | Texture style |
|---|---|
| `tokyo-night` | Subtle dual radial glow (blue/purple) |
| `soft-pastel` | Tri-color pastel halos |
| `glassmorphism` | SVG fractal noise (grain) |
| `aurora` | Triple radial glows matching aurora palette |
| `editorial-serif` | Paper-like SVG noise |

### Per-slide control

Override or disable texture on individual slides via inline style:

```html
<!-- disable texture for this slide -->
<section class="slide" style="--bg-texture: none;">

<!-- custom texture for this slide -->
<section class="slide" style="--bg-texture: radial-gradient(circle at 50% 50%, rgba(255,200,0,.08), transparent 50%);">
```

### Interaction with decorations & FX

- `--bg-texture` uses the `background` property of `.slide` — no pseudo-elements consumed.
- Decorations (`deco-*`) use `::before` / `::after` — **no conflict** with `--bg-texture`.
- Canvas FX (`data-fx`) renders on a `<canvas>` behind content — **no conflict**.
- All three systems can be combined freely on the same slide.
