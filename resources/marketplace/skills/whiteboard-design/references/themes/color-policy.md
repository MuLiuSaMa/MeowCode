# Whiteboard Color Policy

Use this policy before choosing colors for a new Whiteboard, intentionally restyling a scene, or generating editable Whiteboard HTML. It defines color ownership and evidence requirements; it does not authorize recoloring a user-owned imported scene.

The `html-report2` checkout informed the data-role rules below, but it is reference-only. Do not modify `html-report2`, copy its page theme into Whiteboard, or add a runtime dependency on it.

## Color decision order

Resolve color direction in this exact order:

1. **Explicit user palette or reference.** Follow user-provided hex values, a supplied palette, or a reference image before every automatic choice. Record it as user-provided direction; do not describe it as an official brand palette unless an official source confirms it.
2. **Named real brand or product.** When a query names a real market brand, product, or sub-brand, research its current official visual system live before drawing. Do not rely on model memory, a remembered logo color, or an unrelated parent-brand color.
3. **Scene-semantic palette.** When no explicit palette or real brand controls the task, use a restrained palette only when the subject has a clear visual context. Give every hue one stable meaning.
4. **`brand-default` fallback.** For an ordinary diagram with no stronger color signal, use the existing `brand-default` theme unchanged. Its id, aliases, versions, and color values are the generic purple fallback and must not be edited to encode a task-specific brand.

A named real brand still triggers live research when the user also supplies an art direction. If the two conflict, the explicit user direction controls the output, and the evidence note must identify the intentional departure from the official system.

## Brand research gate

Resolve the exact entity before selecting colors. Product-specific guidance outranks a parent-company palette when the Whiteboard is about that product. Current regional guidance outranks a legacy identity. If the query could refer to multiple products, regions, or brand eras and the choice would materially change the result, ask a targeted question before drawing.

Use sources in this order:

1. A current official product or sub-brand guideline, design system, press kit, media kit, or asset portal.
2. A current official parent-brand guideline, design system, press kit, media kit, or asset portal when no product-specific system exists.
3. The current official product website, first-party product interface, or first-party launch material.
4. A reputable secondary source only as corroboration or, with explicit user acceptance, as a public-visual inference. Never label a secondary-source extraction as official.

A user-supplied official document or URL enters the hierarchy at its corresponding official level. Check that it matches the exact entity and is current enough for the task.

Keep a compact evidence note beside the task source files with:

- exact brand or product name, parent/sub-brand relationship, region, and identity era when relevant;
- research date in ISO format;
- source title, URL, and source kind;
- extracted primary, accent, neutral, data-series, and semantic colors, limited to roles actually supported by the source;
- the current light/dark tendency, dominant background and neutral treatment, expected accent proportion, and data-color style rather than only the logo's main color;
- whether each value is explicitly published, sampled from current first-party material, user-provided, or derived;
- conflicts between sources or user direction and how they were resolved;
- any contrast-safe text choice, tint, or series color derived from an official color rather than published by the brand.

Match the brand's visual tendency without copying a marketing page as Whiteboard structure. Preserve Whiteboard readability, editable node hierarchy, restrained fills, neutral relationship lines, and accessible text contrast. Gradients, photography treatments, full-bleed color fields, and promotional decoration are not automatically transferable to a working diagram.

When no usable official source can be found, record the failed research, do not produce or describe a brand-matched final, and ask the user for a guideline or approval to use a clearly labeled public-visual inference. Only with explicit approval may a neutral non-brand draft use the user's palette, a restrained scene-semantic palette, or the unchanged `brand-default` fallback. Never invent an “official” hex value.

## Color role boundaries

Keep these layers separate:

| Layer | Purpose | Rules |
|---|---|---|
| Neutral and structure | Whiteboard background, ordinary nodes, containers, body text, outlines, grids, axes, and connectors | Keep structure quiet and readable. Ordinary connectors remain neutral. A registered theme may reserve one primary connector for a genuine core path, but data-series, accent, and status colors never become routine connector or outline colors. |
| Brand and accent | Primary node, title emphasis, owned brand marks, and one or two exceptional accents | Use the brand primary sparingly for hierarchy, not as a fill for every card. A derived tint is a task color, not an official brand color, unless the source publishes it. |
| Data series | Bars, lines, points, areas, slices, heat cells, legend markers, and other data marks | Use only for data categories. Keep assignment order stable and never leak series colors into ordinary nodes, cards, connectors, or decorative surfaces. |
| Semantic status | Info, success, reminder, warning, error, positive, or negative meaning | Use only when the encoded variable is a real state, risk, health, or direction. Prefer labels, icons, borders, or small soft fills; do not use status colors merely to make categories varied or to create mood. |

For generic Whiteboard data, interpret the existing `brand-default` series by role:

- `series[0]` through `series[3]` are the maximum four peer series. Consume only as many as needed.
- `series[4]` is the neutral **Other** or residual/long-tail group, not a fifth peer series.
- `series[5]` is an exceptional distinct accent, not another automatic peer color.
- If more than four peer categories remain, group the long tail as **Other**, use direct labels or small multiples, or change the visual encoding. Do not keep inventing colors.
- Use semantic colors only for real status or direction. A positive green and a negative red must not silently mean “series A” and “series B.”

An Excalidraw `line` is structural by default. When a line is a chart/data mark, add `customData.canvasColorRole: "data-series"`; strict validation then requires its stroke to come from `series`, `data.other`, or `data.accents`. For a line that encodes a genuine status, use `customData.canvasColorRole: "semantic-status"`; its stroke must come from `semantic`. Untagged lines remain connectors and may use only connector colors. Arrows always remain structural connectors.

For a brand task, use officially supported data colors when available. If the brand publishes only a primary color, build the smallest contrast-safe task series from documented or derived shades, record every derivation, and keep **Other** neutral.

## Multi-brand comparison

Use a neutral background, containers, text system, axes, and connectors so no participant owns the whole Whiteboard. Give each brand color only to that brand's label, mark, logo-adjacent accent, or corresponding data series. Keep compared brands equal in area and visual weight, document the series order, and separate status meaning from brand identity. Do not recolor one brand with another brand's palette or use one participant's brand color as the page background.

## Task-scoped theme workflow

Do not register a one-off brand or user palette in the bundled `references/themes/manifest.json`, and do not edit `brand-default`. Create a task-scoped manifest instead:

```bash
node <skill-root>/scripts/create-task-theme.mjs \
  --spec palette.json \
  --out-dir task-theme
```

The output directory contains `manifest.json`. Use that same manifest and theme id for theme inspection, strict color/style validation, and HTML generation:

```bash
node <skill-root>/scripts/show-theme.mjs \
  --theme-manifest task-theme/manifest.json \
  --diagram-theme task-brand

node <skill-root>/scripts/validate-scene-theme.mjs \
  --scene diagram.excalidraw \
  --theme-manifest task-theme/manifest.json \
  --diagram-theme task-brand \
  --strict

node <skill-root>/scripts/validate-scene-style.mjs \
  --scene diagram.excalidraw \
  --theme-manifest task-theme/manifest.json \
  --diagram-theme task-brand \
  --strict

node <skill-root>/scripts/build-canvas-html.mjs \
  --scene diagram.excalidraw \
  --out diagram.html \
  --ui-theme warm-gray \
  --theme-manifest task-theme/manifest.json \
  --diagram-theme task-brand \
  --strict-colors \
  --strict-style
```

Replace `task-brand` with the `id` in the task spec. Keep the palette spec and generated task-theme bundle at least beside the source `.excalidraw`, together with the rebuild instructions; the final HTML alone is not the reproducible brand evidence. The delivered HTML remains self-contained. If only HTML is handed off, list the official source links and research date in the delivery note.

Treat a material palette change as a new theme revision: generate it under a new task-theme `id`, then use a new Whiteboard `--id` when old per-tool style memory must not carry forward. Reusing the same theme id and Whiteboard id preserves autosave and explicit user tool overrides, so it must not be used as a silent restyle or migration.

### Minimal task-theme spec

This official-source spec is syntactically valid but illustrative; `example.com` is not brand evidence. Replace the example identity, URL, date, and colors with live official evidence before using it for a real task:

```json
{
  "id": "task-brand",
  "brand": {
    "name": "Example Product",
    "checkedAt": "2026-08-03",
    "sources": [
      {
        "kind": "official-brand-guidelines",
        "url": "https://example.com/brand-guidelines"
      }
    ]
  },
  "palette": {
    "primary": "#1457D9",
    "series": ["#1457D9", "#53A5FD"],
    "other": "#9AA3AF"
  }
}
```

For a palette supplied directly by the user, omit a fabricated URL and write the source explicitly:

```json
{
  "id": "task-user-palette",
  "brand": {
    "name": "User-directed Whiteboard",
    "checkedAt": "2026-08-03",
    "sources": [
      {
        "kind": "user-provided",
        "reference": "Query specifies #1457D9; attached reference palette.png"
      }
    ]
  },
  "palette": {
    "primary": "#1457D9",
    "series": ["#1457D9", "#53A5FD"],
    "other": "#9AA3AF"
  }
}
```

Use `kind: "scene-derived"` plus a short `reference` for a non-brand semantic palette derived from task content. If a real brand is also named, include its official URL source in addition to any `user-provided` source.

`palette.primary` and one to four unique `series` colors are required. `background`, `text`, `mutedText`, `connector`, `onPrimary`, `emphasisFill`, `emphasisText`, neutral `other`, up to two unique `accents`, `semantic`, `neutral`, and `secondary` are optional. `other` must not duplicate a series color; accents must not duplicate each other, a series color, or **Other**. `semantic` may be a nested color-role object and may reuse a color when the same color genuinely carries both meanings. `neutral` and `secondary` may be a fill color or a `{fill, stroke, text}` object.

Missing structure colors inherit the unchanged `brand-default` structure. When omitted, `onPrimary` and `emphasisText` are each chosen as the higher-contrast white or default text black for their final fills, while `emphasisFill` is derived by mixing the primary at 12% into the background. Explicit `onPrimary` and `emphasisText` choices must reach at least 4.5:1 contrast against their fills. The generated theme records automatic choices in `brandEvidence.derivations`; treat them as derived task colors, not published brand colors.

## Imported-scene safety

An imported user scene remains the source of truth. Theme selection and task-theme generation govern new scenes, explicitly requested restyling, and future manual-tool defaults; they do not migrate existing elements.

- Preserve imported element ids, files, bindings, background, fills, strokes, text colors, and explicit user overrides.
- Report off-theme colors or low contrast instead of silently replacing them.
- If the user requests restyling, snapshot first, define the exact element scope, and change only that scope.
- Build and runtime code must embed and reopen the source scene without load-time recoloring. Apply theme presets only to future elements.
