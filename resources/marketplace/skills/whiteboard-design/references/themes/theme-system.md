# Whiteboard Theme System

Use this reference when selecting, adding, or validating UI colors plus diagram colors and styles.

## Contents

- [Separation rule](#separation-rule)
- [Discover and inspect themes](#discover-and-inspect-themes)
- [UI Theme rules](#ui-theme-rules)
- [Diagram Theme selection](#diagram-theme-selection)
- [Task-scoped Diagram Themes](#task-scoped-diagram-themes)
- [Diagram style defaults](#diagram-style-defaults)
- [Scene validation](#scene-validation)
- [HTML generation](#html-generation)
- [Adding a theme](#adding-a-theme)

## Separation rule

- UI Theme controls editor surfaces, toolbar/popover backgrounds, borders, text, hover, selected, focus, and accent states.
- Diagram Theme controls document background plus element fill, stroke, text, connector, structural hierarchy, series colors, and generated-element style defaults.
- Never read UI semantic tokens while styling diagram elements.
- Never restyle or recolor scene elements when loading or rendering HTML.
- Share brand primitives only through `primitives/brand-default.json`.

The primitives file contains only the selected subset from `Light.tokens.json`. Keep the original source token path in every primitive key. The stable UI id remains `warm-gray` for backward compatibility, but its values now represent the product's neutral light theme.

## Discover and inspect themes

```bash
node <skill-root>/scripts/show-theme.mjs --list
node <skill-root>/scripts/show-theme.mjs --ui-theme warm-gray
node <skill-root>/scripts/show-theme.mjs --diagram-theme brand-default
```

The command resolves primitive references and returns concrete color and style values ready for element creation.

## UI Theme rules

- Use `bg-overlay-l1` for hover and `bg-overlay-l2` for selected fills.
- Use the neutral `bg-invert` family for high-emphasis actions.
- Use `text-brand` for links. Outside links, use the brand purple only for thin focus and canvas-selection outlines.
- Do not fill ordinary selected controls, toolbar buttons, or high-frequency interaction states with brand purple.
- Use the official `status.success-*`, `status.warning-*`, and `status.error-*` families for UI feedback only. Diagram elements never inherit these UI status colors.
- Use `text-disabled` and `icon-disabled` for disabled controls. Use neutral overlay levels L3 and L4 for the scrollbar default and hover states. Keep slider completed track, remaining track, and thumb on the dedicated `slider.trackActive`, `slider.trackInactive`, and `slider.thumb` UI tokens.
- In the source repository, keep every Excalidraw color alias and literal-color selector override in `excalidraw-cn-single/src/excalidraw-ui-theme.css`. That maintenance file is not shipped in the runtime Plugin package. It may reference only resolved `--canvas-ui-*` variables; raw theme values stay in the UI Theme.

## Diagram Theme selection

Read `color-policy.md` for the complete evidence, role, multi-brand, and fallback rules. Select colors in this exact order:

1. Honor an explicit user palette or reference image.
2. For a named real brand or product, research its current official visual system live and use a task-scoped Diagram Theme.
3. When neither applies but the subject has a clear visual context, derive a restrained scene-semantic palette.
4. When none applies, use `brand-default` unchanged as the generic purple fallback.

Do not force every scene into the same purple palette. Keep meaningful hues limited and assign stable semantic roles instead of coloring each card independently. Keep neutral/structural colors, brand/accent colors, data-series colors, and semantic status colors separate. Ordinary connectors stay neutral; status colors appear only when the encoded variable is a real state, risk, health, or direction.

Legacy ids `architecture`, `intent-flow`, and `prompt-structure` are compatibility aliases to `brand-default` and are intentionally omitted from the active theme list.

When `brand-default` is selected, use the warm `bg-base-secondary` (`#F7F6F5`) for the document background and give every rectangle, ellipse, and diamond an opaque role fill. Use `node.secondary` (`#FAFAFA`) for large containers and supporting structure, and `node.neutral` (`#FFFFFF`) for ordinary card-like nodes. Use `node.emphasis` (`#EEEFFF` with a thin `#654ACB` stroke) for restrained secondary emphasis. Use `node.primary` only for a genuine core module: its fill and stroke use the same purple `#654ACB`, with white text, so the heavy color block never gains a darker contrasting outline. Use at most one primary node and normally no more than two emphasis nodes per visual group; use neither when hierarchy is already clear.

Use brand black `#0A0A0A` for labels on all light role fills. Use the product neutral grey for normal connectors, `border-neutral-l3` for ordinary node outlines, and `border-neutral-l2` for secondary structure. A single core path may use `document.primaryConnector` (`#654ACB`) at width 2; keep every other connector neutral. Never use `accent-*` or `viz-series-*` colors for connectors or structural outlines. A chart mark built with Excalidraw `line` must set `customData.canvasColorRole` to `"data-series"`; without that tag it remains a structural connector and strict validation rejects series colors. The theme intentionally has no default success, warning, danger, or other semantic status roles. When content explicitly requires status color, treat it as a reported non-default exception; otherwise communicate status through labels, icons, shapes, or annotations.

`brand-default` version 5 adds the solid-purple core role, preserves light purple as a separate emphasis role, and increases title hierarchy. Version 4 used the light-purple role as primary. Preserve imported version-1 through version-4 scene colors exactly; validation may report drift and must never migrate them silently.

Use `series` only for data categories that need color distinction. Consume only as many entries as required, keep the order stable, and avoid assigning a different color to every diagram node. In `brand-default`, `series[0]` through `series[3]` are the maximum four peer series, `series[4]` is neutral **Other**, and `series[5]` is an exceptional distinct accent rather than another automatic peer. Do not invent extra hex colors.

## Task-scoped Diagram Themes

Do not add one-off brands, user palettes, or scene palettes to the bundled manifest, primitives, or `brand-default`. Create a task-scoped manifest from a researched palette spec:

```bash
node <skill-root>/scripts/create-task-theme.mjs \
  --spec palette.json \
  --out-dir task-theme
```

Inspect the result with the generated manifest and the spec id:

```bash
node <skill-root>/scripts/show-theme.mjs \
  --theme-manifest task-theme/manifest.json \
  --diagram-theme <task-theme-id>
```

Pass the same `--theme-manifest task-theme/manifest.json` and `--diagram-theme <task-theme-id>` to both validators and `build-canvas-html.mjs`. Missing optional structure colors inherit the stable `brand-default` structure, while supplied and derived task colors remain isolated from the bundled fallback. See `color-policy.md` for the spec, research evidence, data-series limits, and source formats.

## Diagram style defaults

Apply the selected registered Diagram Theme's style profile to every new or intentionally restyled scene. For an unregistered scene-derived palette, retain the structural defaults below while deriving only the colors from the scene. Use explicit values instead of relying on Excalidraw defaults:

| Surface | Default |
|---|---|
| Shapes | Opaque role fill, `roughness: 0`, width 1, solid stroke/fill, opacity 100 |
| Text | Helvetica/system sans; body, introduction, and node label 16px; group or table title 20px; canvas title 28px |
| Rectangles | Adaptive small roundness `{"type": 3}`; add `"value": N` when an exact maximum radius is requested |
| Arrow type | Two-point route; straight for clear local paths, elbowed for cross-region or obstacle-avoiding paths |
| Arrow endpoints | `startArrowhead: null`, `endArrowhead: "triangle"` |

Left-align canvas titles, group titles, and introductions. Keep 12px between a title and its introduction, then at least 24px before the first diagram row. Center labels inside ordinary nodes and keep them to two lines at most. Place large-zone headings as free-standing text at the top-left of the zone instead of binding them to the container.

Excalidraw roundness types are semantic, not interchangeable. Use `{"type": 3, "value": 16}` for an adaptive rectangle whose rendered corner radius is capped at 16px. Do not use `{"type": 1, "value": 16}` to represent 16px: type 1 is legacy proportional roundness, so the numeric value does not produce the requested pixel radius. When the user asks for a uniform radius, apply the same adaptive value to the complete intended rectangle set; do not mix radius systems unless the user asks for distinct roles.

For editable Whiteboard HTML, derive the manual tool presets from these same tokens at build time. Initialize rectangle, diamond, and ellipse tools from `node.neutral` plus `style.shape`; initialize arrows and lines from `document.connector` plus `style.arrow`; initialize text from `document.text` plus `style.text`. When the user creates a new bound shape label, use `#0A0A0A` on light role fills and white on `node.primary`. Apply this role default only to the actively edited, newly created bound text; preserve imported text, pasted text, existing text, and later explicit user color choices. Remember later user changes per tool. Tool selection may change only Excalidraw's `currentItem*` defaults for future drawing and must never mutate existing scene elements.

The CLI `"text"` shorthand creates a bound label that initially inherits its container stroke. After shape creation or Mermaid conversion, query the generated text elements by `containerId` and explicitly update each bound label to its role text color before strict validation: `#0A0A0A` for `neutral`, `secondary`, and `emphasis`; `#FFFFFF` for `primary`. Color validation checks the shape fill/stroke pair, bound-label/container pair, and connector role, so a globally allowed color used in the wrong role still fails strict mode.

Use transparent backgrounds only for arrows, lines, and independent text. Strict color validation treats a missing or transparent `backgroundColor` on a rectangle, ellipse, or diamond as a violation.

Use width 2 only for a core path or focal node. Use dashed strokes only for boundaries or secondary, optional, asynchronous, or mapping relationships. Use square corners only for tables or strict grids. Use Cascadia only for code, paths, or technical identifiers. Use elbowed arrows for cross-region routing, obstacle avoidance, or dense card layouts; keep them as two-point endpoint-bound connectors when drag behavior must remain dynamic. Use a curve only when spacing and elbowed routing cannot clarify a static fan-out.

Never infer a sketch exception from diagram content. Use roughness above 0, handwritten/display fonts, hachure or cross-hatch fills, dotted strokes, width 4, free-draw elements, or non-triangle decorative arrowheads only when the user explicitly requests another visual language.

## Scene validation

```bash
node <skill-root>/scripts/validate-scene-theme.mjs \
  --scene diagram.excalidraw \
  --diagram-theme brand-default \
  --strict
```

Strict validation reports element id, property, and off-token value, including a document background that differs from the selected registered Diagram Theme. It never changes the scene. Validate a generated task theme strictly through its task manifest. Skip strict color mode only when preserving an unregistered or imported palette; report the exception and continue with applicable structural and style validation.

Validate style separately so the existing color-validation interface remains backward compatible:

```bash
node <skill-root>/scripts/validate-scene-style.mjs \
  --scene diagram.excalidraw \
  --diagram-theme brand-default \
  --strict
```

Style validation treats hand-drawn choices and unsupported arrowheads as violations. It reports allowed non-default choices such as width 2, dashed strokes, square corners, Cascadia, elbowed arrows, and curves as warnings that require a semantic reason. For a new scene, missing style fields are violations. For an imported user scene, report drift without rewriting unless the user explicitly requests restyling.

## HTML generation

```bash
node <skill-root>/scripts/build-canvas-html.mjs \
  --scene diagram.excalidraw \
  --out diagram.html \
  --ui-theme warm-gray \
  --diagram-theme brand-default \
  --strict-colors \
  --strict-style
```

The HTML embeds resolved UI Theme variables, Diagram Theme metadata, and compact theme-derived editor defaults. The runtime applies UI variables to the editor shell, uses the editor defaults for future manual drawing, and preserves existing scene styles and colors exactly.

## Adding a theme

This section is for durable product themes only. For a task-specific brand, user palette, or scene palette, use `create-task-theme.mjs` and leave the bundled manifest and `brand-default` unchanged.

1. Add raw reusable colors to `primitives/brand-default.json` only when needed.
2. Add a UI or Diagram Theme JSON file with structural token names.
3. Register its id and path in `manifest.json`.
4. Run `show-theme.mjs` to catch missing references and invalid colors.
5. For Diagram Themes, validate colors and styles on a representative scene in strict mode.
6. For UI Themes, rebuild the maintenance template and visually check default, hover, selected, focus, toolbar, and popover states. The build resolves the manifest defaults into the `index.dev.html` data slot; keep that source slot free of hard-coded palette values.

Do not add element-id-specific color overrides. Do not add load-time migration maps. Version themes when changing existing token meaning.
