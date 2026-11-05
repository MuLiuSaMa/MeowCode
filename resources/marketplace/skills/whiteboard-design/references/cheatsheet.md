# Controlled Whiteboard Cheatsheet

## Contents

- [Startup](#startup)
- [Commands](#commands)
- [Payload format](#payload-format)
- [Design guide](#design-guide)
- [Recovery](#recovery)

## Startup

Run every live-canvas operation through:

```bash
node <skill-root>/scripts/canvas-cli.mjs <command>
```

The first run downloads the fixed top-level Whiteboard CLI package; npm resolves its transitive graph at install time. Whiteboard-touching commands automatically start an internal loopback service unless `EXCALIDRAW_NO_AUTOSTART=1` is set. Keep `EXPRESS_SERVER_URL`, `CANVAS_WORKBENCH_URL`, and any `--url` override on `127.0.0.1`, `localhost`, or `::1`; the wrapper rejects other hosts.

Start the shared reduced workbench and open only the URL it prints:

```bash
node <skill-root>/scripts/serve-canvas-workbench.mjs
```

Do not open the raw backend canvas. The workbench and final HTML use the same hidden-feature policy. User-facing import, export, save, clear, background, theme, help, library, Generate, and Mermaid entries are disabled; the agent may still use the allowed internal `export` and `import` commands through the wrapper when the workflow requires them.

The wrapper is a workflow boundary rather than a system security sandbox. Never bypass it from this skill. Results are JSON on stdout except `describe` and raw scene or SVG output. Diagnostics use stderr.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Runtime or validation error |
| 2 | Invalid command usage |
| 3 | Whiteboard service unreachable |
| 4 | Browser tab required |

## Commands

### Server

| Command | Description |
|---|---|
| `start` | Start the local service and print its URL and process id |
| `stop` | Stop the identity-checked local service |
| `status` | Report health, element count, and connected browser tabs |

### Elements

| Command | Description |
|---|---|
| `add [file\|-]` | Create elements from a JSON array; `--one '{...}'` creates one |
| `apply [file\|-]` | Apply one `create` / `update` / `delete` patch |
| `get <id>` | Read one element |
| `query` | Filter by type, bounding box, typed field, or `--filter-json` |
| `update <id> --set '{...}'` | Update one element |
| `delete <id> [...]` | Delete confirmed elements |

### Scene

| Command | Description |
|---|---|
| `describe` | Summarize ids, types, bounds, labels, and connections |
| `screenshot` | Capture PNG or SVG; browser tab required |
| `export --browser [--out f.excalidraw]` | Export the portable scene from exactly one Workbench tab |
| `export [--out checkpoint.excalidraw]` | Save a headless compact server checkpoint; not the final portable scene |
| `import [file\|-] [--replace]` | Merge or replace from a scene |

### Arrange

| Command | Description |
|---|---|
| `arrange align --ids a,b --to left` | Align selected elements |
| `arrange distribute --ids a,b,c --to horizontal` | Distribute at least three elements |
| `arrange group --ids a,b` | Group elements |
| `arrange ungroup --group <groupId>` | Remove one group relationship |
| `arrange lock\|unlock --ids a,b` | Change edit locking |
| `arrange duplicate --ids a,b [--offset 20,20]` | Clone elements with an offset |

### State and output

| Command | Description |
|---|---|
| `snapshot save <name>` | Save the current state before risky edits |
| `snapshot list` | List named snapshots |
| `snapshot restore <name>` | Restore a named snapshot |

### Rejected commands

| Command | Reason |
|---|---|
| `clear` | Global destructive action is outside the reduced workflow |
| `share` | External publishing is outside the local canvas scope |
| `mermaid` | Conversion UI is intentionally removed; rebuild the structure with `add` or `apply` |
| `install-skill` | Self-modification is outside a drawing task |
| Any unknown command | The command allowlist fails closed |

Run `node <skill-root>/scripts/canvas-cli.mjs --help` to view the allowlist.

## Payload Format

- Put `"text": "Label"` on a shape to create a bound text label. This shorthand initially inherits the container stroke; after creation or structure reconstruction, query the generated text element by `containerId` and update its `strokeColor` to `#0A0A0A` on light roles or `#FFFFFF` on the solid-purple core.
- Bind arrows with `"startElementId": "a"` and `"endElementId": "b"`.
- Use `"fontFamily": "helvetica"` for normal text and `"cascadia"` only for code-like text.
- `points` accepts `[[x, y], ...]` or `[{"x": 0, "y": 0}, ...]`.
- An `apply.update` entry may use direct fields or a `set` object. Do not mix them in one entry.
- Create shapes first, then arrows, then alignment or grouping.

Canonical normal arrow:

```json
{
  "type": "arrow",
  "roughness": 0,
  "strokeWidth": 1,
  "strokeStyle": "solid",
  "opacity": 100,
  "startArrowhead": null,
  "endArrowhead": "triangle",
  "roundness": null,
  "elbowed": false
}
```

## Design Guide

### Theme

Inspect the active Diagram Theme with:

```bash
node <skill-root>/scripts/show-theme.mjs --diagram-theme brand-default
```

Read `references/themes/color-policy.md` before choosing colors. The order is explicit user palette/reference, live official research for a named real brand or product, restrained scene-semantic palette, then unchanged `brand-default` purple fallback. Separate neutral structure, brand accents, data series, and real semantic status; use at most four peer series, keep **Other** neutral, and keep ordinary connectors neutral.

For a brand, user, or scene palette, create a task-scoped manifest instead of changing the bundled fallback:

```bash
node <skill-root>/scripts/create-task-theme.mjs \
  --spec palette.json \
  --out-dir task-theme

node <skill-root>/scripts/show-theme.mjs \
  --theme-manifest task-theme/manifest.json \
  --diagram-theme <task-theme-id>
```

Pass the same `--theme-manifest` and theme id to both validators and the HTML builder.

For a chart/data `line`, set `customData.canvasColorRole` to `"data-series"`; for a genuine status line, use `"semantic-status"`. Untagged lines remain structural connectors and strict validation rejects series or status colors on them. When a palette changes materially, use a new task-theme id; use a new Whiteboard `--id` too if saved per-tool overrides must not carry forward.

When `brand-default` is selected, use document background `#F7F6F5`. Every rectangle, ellipse, and diamond needs an opaque fill: ordinary nodes use `#FFFFFF`, supporting containers use `#FAFAFA`, restrained emphasis uses `#EEEFFF`, and at most one genuine core node per visual group uses solid `#654ACB` with white text. Give that core the same `#654ACB` stroke instead of a darker outline. Use neutral structural strokes and connectors; reserve a width-2 purple connector for one genuine main path. Do not invent colors outside the active theme.

Validate without modifying the scene:

```bash
node <skill-root>/scripts/validate-scene-theme.mjs \
  --scene diagram.excalidraw \
  --diagram-theme brand-default \
  --strict

node <skill-root>/scripts/validate-scene-style.mjs \
  --scene diagram.excalidraw \
  --diagram-theme brand-default \
  --strict
```

### Layout

- Use shapes at least 120×60px and width at least `labelChars * 12`.
- Use 16px for body, introduction, and node text; 20px for group or table titles; and 28px for the canvas title.
- Left-align titles and introductions. Keep 12px from title to introduction and at least 24px from introduction to diagram content.
- Center node labels and keep them to two lines at most.
- Keep normal gaps between 40px and 80px; allow at least 120px for labeled arrows.
- Use a 20px alignment grid where practical.
- Put background zones first, then primary shapes, bound arrows, and annotations.
- Use free-standing text for zone headings. Bound zone labels are centered and will overlap their contents.
- Move elements before introducing complex arrow routing.
- Use elbowed perimeter routes only for obstacles or cross-region relationships.
- Use curves only when layout and elbowed routing cannot clarify a fan-out.

### Visual loop

1. Run `describe`.
2. Apply one coherent batch.
3. Capture and inspect a screenshot.
4. Fix truncation, overlap, routing, or style drift.
5. Repeat until the entire scene passes.

## Recovery

- Exit code 3: check `EXPRESS_SERVER_URL`, then run `start`.
- Exit code 4: start the reduced workbench, open its printed URL, and retry.
- Element missing: use `describe` to check whether it is off-screen.
- Update rejected: verify the id and unlock the element if necessary.
- Scene unstable: save a snapshot before a broad import or rebuild.
- Duplicate bound text: wait for synchronization, query text elements with `containerId`, and delete only confirmed duplicates.
