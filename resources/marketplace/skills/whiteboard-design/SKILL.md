---
name: whiteboard-design
description: Plan, create, edit, validate, and export editable visual whiteboards as self-contained Whiteboard HTML by default, with .excalidraw retained as the editable source. Use for information architecture, visual hierarchy, relationship maps, editable diagrams, scene import/export, theme enforcement, and browser-free delivery through the bundled controlled workbench.
---

# Whiteboard Design Skill

## Use the controlled workbench

Use one control path for every live-canvas operation:

```bash
node <skill-root>/scripts/canvas-cli.mjs <command>
```

The first command downloads the fixed top-level drawing CLI package; its transitive npm graph is resolved at install time. Whiteboard-touching commands start an internal loopback service automatically. Start the reduced workbench separately and open only the URL it prints:

```bash
node <skill-root>/scripts/serve-canvas-workbench.mjs
```

The generation workbench and final HTML use the same editor shell and capability policy. Do not open the raw backend canvas. Do not call the upstream CLI directly. The wrapper rejects `clear`, `share`, `mermaid`, `install-skill`, unknown commands, and non-loopback control URLs before starting a child process. Keep exactly one Workbench tab open when exporting the portable scene.

Treat this wrapper as a workflow boundary, not a system security sandbox: another process could bypass it. Within this skill, always use the wrapper. Read `references/cheatsheet.md` when allowed commands, payload formats, exit codes, or recovery steps are needed.

## Plan the Visual Before Drawing

Before creating elements, make a compact internal visual plan:

1. State the reader outcome in one sentence: what should a reader understand, compare, decide, or remember?
2. Classify the material by role: core claim, evidence or examples, relationships, context, reference or index, and actions or questions.
3. Group content by cognitive purpose rather than by source order.
4. Choose a visual grammar for each group: comparison, spatial cluster, relationship network, sequence, hierarchy, matrix, or index.
5. Set the reading path, focal area, and approximate space allocation before placing objects.
6. Sketch a low-fidelity internal frame first. Unless the user explicitly asks for a wireframe, continue to a complete, information-rich canvas.

Do not turn every ordered or labeled item into a connected graph. Use connectors only when the connection itself carries meaning.

For data-heavy summaries, treat the source as evidence rather than a layout. Identify the headline result, comparisons, exceptions, and actions first; then choose visual encodings for them. Read `references/visual-planning.md` and `references/layout-grammar.md` before creating or substantially redesigning a canvas.

## Route the Task

1. For a new canvas or substantial redesign, first read `references/visual-planning.md` and `references/layout-grammar.md`.
2. For editable relationships between draggable nodes, read `references/editable-bindings.md`.
3. For changes to an existing artifact, read `references/iteration-policy.md` and patch the existing source instead of rebuilding it.
4. For any new or existing diagram, inspect the active Diagram Theme and work through the controlled wrapper. Default to a browser-free workflow: use `describe` plus strict theme/style validation, and do not open the reduced workbench or take screenshots unless the user explicitly requests a visual preview or a concrete rendering problem cannot be resolved structurally.
5. For Mermaid input, interpret its structure and recreate it with allowed `add` or `apply` commands. Do not invoke the disabled conversion command.
6. For every user-facing Whiteboard drawing, complete the normal scene workflow, then follow `references/canvas-html-contract.md` and deliver a self-contained editable HTML. Skip HTML only when the user explicitly requests source-only `.excalidraw` output.
7. For color selection, a named real brand or product, or theme changes, read `references/themes/color-policy.md` and `references/themes/theme-system.md` before drawing or editing theme data. A named real brand or product requires live official-source research.
8. For a user-owned imported scene, report validation drift without silently restyling it unless the user explicitly asks for restyling.

## Theme Contract

Before creating a diagram or Whiteboard HTML, inspect the available Diagram Themes and the bundled fallback:

```bash
node <skill-root>/scripts/show-theme.mjs --list
node <skill-root>/scripts/show-theme.mjs --diagram-theme brand-default
```

Follow the complete evidence and role contract in `references/themes/color-policy.md`. Choose diagram colors in this exact order:

1. Follow an explicit user palette or reference image.
2. For a named real brand or product, research its current official visual system live and create a task-scoped theme. Do not use memory or a guessed logo color as brand evidence.
3. When no explicit palette or real brand applies and the subject has a clear visual context, use a restrained scene-semantic palette with stable roles.
4. For an ordinary diagram with no stronger color signal, use `brand-default` unchanged as the purple fallback.

Do not edit the bundled `brand-default` theme for one task. Generate a task-scoped theme with `scripts/create-task-theme.mjs`, then pass its generated `manifest.json` through `--theme-manifest` to `show-theme.mjs`, both validators, and `build-canvas-html.mjs`. Keep neutral/structural colors, brand accents, data series, and semantic status colors in separate roles. Use no more than four peer data-series colors; keep **Other** neutral; use status colors only for real status; and keep ordinary connectors neutral.

Do not force unrelated scenes into the same purple palette. Keep the number of meaningful hues small, and use each hue consistently for the same semantic role. When `brand-default` is selected, its core rules are:

- Use document background `#F7F6F5`.
- Give every rectangle, ellipse, and diamond an opaque role fill.
- Use `#FFFFFF` for ordinary nodes and `#FAFAFA` for containers or supporting structure.
- Use light purple `#EEEFFF` for restrained emphasis and solid brand purple `#654ACB` for at most one genuine core node per visual group. A core node uses the same `#654ACB` for fill and stroke, so it has no darker contrasting outline.
- Use brand black `#0A0A0A` on light node fills and white on the solid-purple core. Verify every generated bound label against its container role; never recolor imported or explicitly styled text.
- Use neutral structural strokes and connectors. Reserve a width-2 `#654ACB` connector for one genuine main path; do not use accent or series colors for ordinary structure.
- Use `roughness: 0`, solid width-1 strokes and fills, opacity 100, Helvetica, and small rounded rectangles.
- Use a straight normal arrow with `startArrowhead: null`, `endArrowhead: "triangle"`, `roundness: null`, and `elbowed: false`.
- Use width 2, dashed strokes, square corners, Cascadia, elbowed arrows, or curves only when they carry an explicit semantic meaning.
- Never infer a hand-drawn exception from words such as “brainstorm,” “whiteboard,” or “draft.”

Keep the two theme domains independent:

- UI Theme controls editor surfaces and interaction states.
- Diagram Theme controls document background and scene element colors and styles.
- Never recolor or restyle scene elements while loading or rendering HTML.
- Apply theme-derived manual-tool presets only to future elements. Preserve existing elements and per-tool user overrides.

Validate exported scenes without rewriting them:

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

Run strict color validation against the selected registered Diagram Theme. For a brand, explicit user palette, or scene-semantic palette, prefer a task-scoped manifest so the complete color and style contract can be validated strictly. For a preserved imported scene or other unregistered palette, report the color-validation exception instead of claiming strict theme-color compliance; never rewrite the scene merely to satisfy the validator.

## Controlled Working Loop

Use `describe` to understand ids, positions, labels, connections, and bounds. This is the default quality check. Use `screenshot` only when the user explicitly asks for a preview, the scene contains compatibility-sensitive imported content, or a concrete rendering issue cannot be determined from structure.

For ordinary generated scenes, export the editable source directly from the controlled service without opening a browser:

```bash
node <skill-root>/scripts/canvas-cli.mjs export --out diagram.excalidraw
```

This headless path produces the default editable source because it avoids browser startup and repeated visual checks. Unless the user explicitly requests source-only output, build a self-contained HTML from that source and make the HTML the primary user-facing deliverable. Use `export --browser` only when the user explicitly requests browser-canonical export or the scene contains imported files, legacy iframe/embeddable elements, complex bindings, or browser-specific text/layout behavior. For browser export, start the reduced workbench, keep exactly one Workbench tab open, and set `CANVAS_WORKBENCH_URL` when it uses a non-default port.

For new diagrams:

1. Define the reader outcome and information hierarchy.
2. Select a visual grammar for each semantic cluster and establish the reading path.
3. Plan the layout and choose stable element ids.
4. Balance images, shapes, labels, and whitespace according to semantic importance.
5. Create primary shapes before arrows.
6. Bind arrows with `startElementId` and `endElementId`.
7. Complete one coherent layout, then run `describe` once to check bounds, labels, and connections.
8. Fix concrete structural problems only. Do not open a browser or take a screenshot by default.

For existing diagrams:

1. Treat the existing `.excalidraw` file as the source of truth and HTML as a generated delivery artifact.
2. Run `describe`.
3. Identify elements by id or label, not by coordinates.
4. Use `update`, `delete`, `arrange`, or one atomic `apply` patch.
5. Preserve unaffected IDs, files, groups, and bindings.
6. Do not redraw the whole canvas or create a parallel HTML file merely to make a local change. Regenerate the existing HTML deliverable from the patched source, preserving its document id and filename.
7. Run `describe` after a visual or structural change. Use a screenshot only under the explicit or compatibility-sensitive conditions above.

Interpret feedback literally and change only the named visual variable. Words such as “all,” “uniform,” and “overall” apply to the complete intended element set, not a representative subset. If the user says the result looks unchanged, check parameter semantics and document-specific autosave before redesigning or opening another version.

Read `references/iteration-policy.md` before changing an existing canvas.

CLI element payload reminders:

- Put `"text": "Label"` on a shape to create a bound label. The command shorthand initially inherits the shape stroke, so after creation or structure reconstruction query the resulting text element by `containerId` and update its `strokeColor` to `#0A0A0A` for a light role or `#FFFFFF` for `node.primary`.
- Use `"fontFamily": "helvetica"` for normal text and `"cascadia"` only for code-like content.
- Use 28px for a canvas title, 20px for a group or table title, and 16px for introductions, body copy, and node labels. Left-align titles and introductions; center node labels and keep them to two lines at most.
- Keep 12px between a title and its introduction, then at least 24px before the diagram content.
- `points` accepts coordinate tuples or `{x, y}` objects.
- An `apply` update may use direct fields or a `set` object, but never both in one update entry.
- Never attach a bound label to a large background zone. Use free-standing text at the zone edge.
- When a card uses separate text elements, give the card background and its text the same `groupIds` so they move together. A short single-label card may instead use bound text.
- For an exact rectangle corner radius, use adaptive roundness with an explicit pixel cap, for example `{"type": 3, "value": 16}`. Do not use `type: 1` for a requested pixel radius; it is legacy proportional roundness and does not interpret `value` as the requested pixels.

## Editable Connectors and Labels

For relationships that must stay editable while nodes move, use the dynamic-editable connector contract:

- Use a two-point connector (`points.length === 2`).
- Bind both ends to the relevant nodes.
- Bind each end to the card or node shape that represents the draggable endpoint, never to its text element or to a group id.
- Do not use `fixedPoint` or intermediate bend points.
- Bind the label to the connector with `containerId`.
- Include the label in the connector's `boundElements`.
- Include the connector in both endpoint nodes' `boundElements`.
- Prefer a straight route for short, unobstructed local relationships. Use a two-point elbowed route for cross-region connections, obstacle avoidance, or dense card layouts. Use dashed strokes only for secondary, optional, asynchronous, or mapping relationships.

Multi-point curves are presentation-oriented: their bend points remain anchored in canvas coordinates when nodes move. Use them only when that limitation is acceptable, and do not describe them as fully dynamic. Read `references/editable-bindings.md` for the complete contract.

## Visual Composition Rules

- Establish one dominant focal area; do not give every object equal weight.
- Use whitespace, alignment, proximity, and subtle dividers before adding containers.
- Avoid card-inside-card layouts. A semantic cluster should usually have at most one visible boundary.
- Use images as visual anchors, shapes as structure, and text as explanation; size each according to importance.
- For data summaries, prefer position, length, area, alignment, and compact tables over prose when they communicate the comparison directly.
- Do not use repeated `|` or `｜` characters to simulate tables, KPI groups, or visual hierarchy.
- Keep explanatory copy subordinate to the evidence. A module should normally contain one claim, one visual proof, and only the text needed to interpret it.
- Do not make every module the same size, color, and contrast. Let importance determine visual weight.
- Keep relationship networks local to content where relationships are the point. Do not use lines merely to encode reading order.
- Use nearby groups for related content and separate unrelated purposes into distinct visual regions.
- Prefer a complete visual explanation over a sparse scaffold unless the user explicitly asks for a sketch.

## Default Quality Gate

Without opening a browser, inspect the scene description and validator output once. Confirm:

1. The reader outcome, focal area, and visual hierarchy are clear.
2. The reading path is understandable without relying on connector lines.
3. No text is truncated.
4. Shapes do not overlap and containers include adequate padding.
5. Containers are not unnecessarily nested.
6. Arrows do not cross unrelated elements.
7. Arrow labels do not collide with shapes and move with their connectors.
8. Dynamic-editable connectors use two points, endpoint bindings, reverse bound-element references, and no `fixedPoint`.
9. Card backgrounds and separate card text share group ids, while connectors bind to the card shapes and remain outside those groups.
10. Connector routing matches complexity: straight for clear local paths, elbowed for cross-region or obstacle-avoiding paths, and dashed only when the relationship semantics justify it.
11. Normal gaps are at least 40px and labeled-arrow gaps are at least 120px.
12. Body and node text use 16px, group or table titles use 20px, and the canvas title uses 28px.
13. Background-zone labels are free-standing rather than centered bound text.
14. Normal arrows end with `endArrowhead: "triangle"`.
15. No unexplained sketch styling, decorative endpoints, heavy strokes, or transparent closed shapes remain.

If any item fails, fix it and rerun only the relevant structural check. Browser visual verification is opt-in, not a default completion requirement.

## Default User Delivery: Editable Whiteboard HTML

Every user-facing Whiteboard drawing must include an editable single-file Whiteboard HTML as the primary deliverable. Retain `.excalidraw` as the editable source of truth and provide it as a secondary source artifact when useful. Omit HTML only when the user explicitly asks for source-only `.excalidraw` output.

Read `references/canvas-html-contract.md` before generating the HTML. That contract defines fast delivery and full runtime acceptance.

Use fast delivery by default:

1. Build the source scene through the controlled wrapper and use `describe` to check its bounds and connections.
2. Export a portable `.excalidraw` scene with `export --out <file>`.
3. Run strict color and style validation.
4. Generate the HTML:

   ```bash
   node <skill-root>/scripts/build-canvas-html.mjs \
     --scene diagram.excalidraw \
     --out diagram.html \
     --title "Diagram title" \
     --id "stable-diagram-id" \
     --ui-theme warm-gray \
     --diagram-theme <selected-registered-theme-id> \
     --strict-colors \
     --strict-style
   ```

5. Deliver the generated self-contained HTML as the primary user-facing artifact without opening it in a browser. Link the `.excalidraw` source second when it helps future editing or reproducibility.
6. Open or visually verify the HTML only when the user explicitly asks for a preview or when build/structural output identifies a concrete compatibility concern.

Use full runtime acceptance only when one of these applies:

- The editor template, capability policy, theme runtime, autosave, or viewport code changed.
- The scene contains imported files, legacy iframe or embeddable elements, complex bindings, or other compatibility-sensitive content.
- Structural/build checks reveal a likely rendering or interaction inconsistency.
- The user explicitly asks for exhaustive validation.

Full runtime acceptance is the browser-based exception path. It adds browser-canonical export, the source-workbench screenshot, temporary shape and arrow edits, autosave and viewport reload checks, preset checks, shortcut and hidden-action checks, and a clean final preview. Follow the complete procedure in `references/canvas-html-contract.md`.

Reuse the same `--id` when regenerating one document. Create a new document id only when the user approves recovery from stale or conflicting autosave. For direct `file://` delivery, also use a new filename during that recovery so browser file caching cannot mask the new document. Never patch the generated HTML by hand.

## Error Recovery

- Exit code 3: start the service explicitly or fix `EXPRESS_SERVER_URL`.
- Exit code 4: start `node <skill-root>/scripts/serve-canvas-workbench.mjs`, open its printed URL, then retry the browser-dependent command.
- Browser export ambiguity: close extra Workbench tabs and retry with exactly one registered tab.
- Missing elements: run `describe`; they may be outside the visible viewport.
- Broken arrow binding: verify endpoint ids with `get`.
- Locked element: run `arrange unlock`.
- Risky broad import or rebuild: save a snapshot first and restore it if necessary.
- Duplicate bound text: wait for synchronization to settle, query text elements with `containerId`, and remove only confirmed duplicates.
- Unexpected old HTML content: clear only that document's autosave entry or use a clean browser context.

## Maintenance Boundary

- `assets/canvas-editor-template.html` is the compiled self-contained editor shared by the live workbench and normal HTML generation.
- `scripts/` contains the controlled command wrapper, browser-export bridge, workbench server, theme, validation, viewport-policy, compatibility normalizer, and HTML-generation runtime.
- `references/themes/` is the source of truth for UI and Diagram Theme data.
- The source repository keeps `excalidraw-cn-single/`, tests, and evals as maintenance assets. They are intentionally not included in this runtime Plugin package.
- Do not patch the minified template directly. Rebuild it from the maintenance source after editor-shell or dependency changes.
- Do not add `node_modules/`, `dist/`, editor maintenance source, or generated test artifacts to this Plugin package.

## References

- `references/visual-planning.md`: reader outcome, information roles, clustering, and grammar selection.
- `references/layout-grammar.md`: hierarchy, proportions, grouping, spacing, and connector discipline.
- `references/editable-bindings.md`: dynamic connector, label, node, and curve contracts.
- `references/iteration-policy.md`: source-of-truth and incremental-edit rules.
- `references/cheatsheet.md`: allowed commands, rejected commands, payload rules, design guidance, and recovery.
- `references/themes/color-policy.md`: color precedence, live brand research, role boundaries, task-scoped themes, and imported-scene safety.
- `references/themes/theme-system.md`: theme separation, tokens, validation, and extension.
- `references/canvas-html-contract.md`: editable HTML interface and acceptance contract.
