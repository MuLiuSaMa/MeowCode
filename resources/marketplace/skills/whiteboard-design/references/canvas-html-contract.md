# Whiteboard HTML Contract

Use this contract for every user-facing Whiteboard drawing. The default deliverable is an editable, self-contained Whiteboard HTML; `.excalidraw` remains the editable source of truth. Skip HTML only when the user explicitly requests source-only `.excalidraw` output. The workbench and standalone modes share one compiled editor shell and capability policy.

## Contents

- [Output contract](#output-contract)
- [Hidden or disabled interface](#hidden-or-disabled-interface)
- [Initial viewport](#initial-viewport)
- [Validation tiers](#validation-tiers)
- [Generation and validation workflow](#generation-and-validation-workflow)
- [Validation gates](#validation-gates)
- [Failure routing](#failure-routing)
- [Storage and versioning](#storage-and-versioning)
- [Scene safety](#scene-safety)

## Output contract

- Make the self-contained HTML the primary artifact linked to the user. Keep the `.excalidraw` scene as the maintained source and optionally link it second.
- Produce one self-contained `.html` file with no external scripts, stylesheets, fonts, or image assets.
- Run the same self-contained editor in two modes: `workbench` synchronizes with the internal loopback service, while `standalone` uses the embedded scene and document-specific local storage.
- Keep the normal selection, shape, arrow, line, free-draw, text, image, eraser, frame, laser, zoom, undo, and redo controls.
- Use `zh-CN` for the Excalidraw interface.
- Autosave edits in browser local storage under a document-specific key.
- Use the token-driven `warm-gray` UI Theme id by default. This stable id resolves to the product's neutral light palette.
- Use the selected Diagram Theme's minimal style profile for both AI-generated and manually drawn elements. Follow `references/themes/color-policy.md`: explicit user palette/reference, live official research for a named real brand or product, scene-semantic palette, then unchanged `brand-default` fallback. Use no hand-drawn fonts or lines, width-1 solid strokes, and triangular arrow endpoints. Choose straight routes for clear local relationships and two-point elbowed routes for cross-region, obstacle-avoiding, or dense layouts.
- Initialize each supported drawing tool from a theme-derived preset. Remember explicit user changes per tool instead of resetting them on every activation.
- Keep UI Theme colors independent from Diagram Theme colors.
- Preserve all scene element styles and colors plus the document background exactly at runtime.
- Open a newly embedded scene at a complete fitted overview without requiring user input. Restore the saved viewport when reopening an autosaved scene.

## Hidden or disabled interface

- Do not render a custom title/header bar.
- Do not render custom import, export, or reset buttons.
- Set `loadScene`, `export`, `saveAsImage`, `saveToActiveFile`, `clearCanvas`, `toggleTheme`, and `changeViewBackgroundColor` to `false` in the embedded capability policy.
- Hide the Excalidraw main menu trigger.
- Hide the library trigger.
- Hide the help trigger.
- Hide the canvas background control; the embedded scene owns the document background.
- Disable AI commands.
- Hide the `Generate` and `Mermaid to Excalidraw` entries.
- Block the help, load, save, image-export, clear, and command-palette keyboard shortcuts so hidden actions cannot be reopened from the keyboard. Keep ordinary text entry, undo, redo, and element deletion working.
- Hide the continuous drawing lock control and its orphaned divider. Block its `Q` shortcut outside editable text, force restored `activeTool.locked` state to `false`, and neutralize any runtime attempt to re-enable it. Preserve element-level `locked` data and element lock/unlock actions.
- Reject Mermaid-formatted paste, all file drops, and `#addLibrary=` URLs. Use the visible image tool for ordinary image insertion; file drop stays disabled because PNG and SVG files may contain an embedded scene.
- Sanitize legacy autosave state before first render so old menu, popup, sidebar, dialog, welcome, file-handle, and pending-image state cannot reopen a hidden action.
- Hide the `Web Embed` / `嵌入网页` entry and prevent `embeddable` from becoming the active tool, including when restoring stale autosave state.
- Do not create new `embeddable` or `iframe` elements through drawing, URL paste, URL drop, or any other interactive path. Paste a plain URL as ordinary text instead.
- Preserve existing `embeddable` and legacy `iframe` elements when loading, importing, editing, autosaving, exporting, and reopening a scene.

## Initial viewport

- Treat element coordinates as scene content and zoom/scroll as Runtime-owned camera state. Do not make the agent calculate or hard-code an initial `zoom`, `scrollX`, or `scrollY` for the generated HTML.
- Use the embedded `initialViewport` policy. The default is `mode: "fit-content"`, `apply: "first-open"`, `viewportZoomFactor: 0.86`, `maxZoom: 1`, `animate: false`, and `restoreSavedViewport: true`.
- In standalone mode, wait for the editor API, fonts, and layout to settle, then fit a fresh embedded scene once. In workbench mode, fit once after the first canonical scene arrives. Leave an empty scene at its default viewport.
- Never enlarge a small scene beyond 100%. Treat a scene that becomes microscopic because of a distant accidental element as a Source Scene Gate failure; fix the source instead of hiding the element in the Runtime.
- Cancel a pending initial fit if the user starts interacting. Never continuously refit after the user pans, zooms, edits, resizes the window, or rotates the device.
- In standalone mode, restore a valid document autosave and its saved viewport, then skip the initial fit. Workbench mode does not read or write standalone autosave. Keep the normal zoom-to-fit control available for manual recovery.
- Initial fitting may change camera state only. It must never move, resize, restyle, recolor, delete, or rebind scene elements.

## Validation tiers

Use **fast delivery** for ordinary new diagrams and routine editable HTML output. It is browser-free by default: validate scene structure, colors, styles, and the generated artifact without opening the workbench or final HTML.

Use **full runtime acceptance** only when:

- the compiled editor template, capability policy, UI Theme Runtime, autosave, tool presets, or viewport behavior changed;
- the scene imports compatibility-sensitive content such as files, complex bindings, legacy `iframe`, or `embeddable` elements;
- fast delivery reveals a rendering or interaction inconsistency; or
- the user explicitly requests exhaustive validation.

Do not promote a task to full runtime acceptance merely because the output is editable HTML.

## Generation and validation workflow

### Fast delivery (default)

1. Read `references/themes/color-policy.md` and `references/themes/theme-system.md`. Select an explicit palette, complete live official-source research for a named real brand or product, choose a scene-semantic palette, or use the unchanged `brand-default` fallback. For any non-bundled palette, generate a task-scoped theme with `create-task-theme.mjs`. Create or refine the scene through `node <skill-root>/scripts/canvas-cli.mjs <command>`. Do not start the workbench by default.
2. Run `describe` once and check content, bounds, labels, and connections. Do not take a screenshot unless the user explicitly requests a visual preview or a concrete compatibility issue cannot be determined structurally.
3. Export the portable scene headlessly with `node <skill-root>/scripts/canvas-cli.mjs export --out diagram.excalidraw`.
4. Validate scene colors and styles in strict mode when using a bundled or task-scoped registered Diagram Theme. For a task theme, append `--theme-manifest <task-theme-dir>/manifest.json` to both commands. For a preserved imported or other unregistered palette, report the color exception and run the applicable structural and style checks:

   ```bash
   node <skill-root>/scripts/validate-scene-theme.mjs \
     --scene diagram.excalidraw \
     --diagram-theme <selected-registered-theme-id> \
     --strict
   node <skill-root>/scripts/validate-scene-style.mjs \
     --scene diagram.excalidraw \
     --diagram-theme <selected-registered-theme-id> \
     --strict
   ```

5. Generate HTML with the bundled template. For a task theme, append the same `--theme-manifest <task-theme-dir>/manifest.json` and use its theme id:

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

6. Confirm the build succeeded, the output is one self-contained HTML file, and the embedded scene metadata matches the exported source.
7. Deliver the HTML as the primary user-facing artifact without opening a browser. Link the `.excalidraw` source second when useful. Repeat export or build only when correcting a concrete structural or validation failure.

Use browser-canonical `export --browser`, a Workbench tab, or a final HTML screenshot only when the user explicitly requests browser verification or preview, or when compatibility-sensitive content requires the full runtime tier.

### Full runtime acceptance

Complete fast delivery, then start the reduced workbench and use the browser exception path:

1. With exactly one Workbench tab open, export the portable scene with `export --browser --out diagram.excalidraw`, rebuild the HTML, take a reduced-workbench screenshot, and pass the Source Scene Gate.
2. In a clean validation context, make a small edit, change the viewport, and reload to confirm editability, autosave, style/color preservation, and restoration of the saved viewport.
3. Select a normal shape tool and the arrow tool. Confirm their initial controls match the Diagram Theme, draw one temporary element with each, and confirm their actual styles match the presets.
4. Exercise the relevant hidden-action, shortcut, paste, drop, or compatibility cases for the Runtime code that changed or the imported content being preserved.
5. Remove temporary elements and capture a clean final preview.
6. If direct file opening is part of delivery, check it separately because browser policy may block `file://` even when the HTML is valid.

## Validation gates

### Source Scene Gate

Use this browser-based gate during full runtime acceptance. In fast delivery, use the same criteria against `describe` and validator output without taking a screenshot:

- Confirm content completeness, readable text, spacing, containment, and connection routing.
- Confirm normal elements use the minimal style profile and arrows use triangular endpoints. Use straight routes for clear local relationships and two-point elbowed routes for cross-region, obstacle-avoiding, or dense layouts.
- Fix truncation, overlap, crossings, or missing elements before export.
- Confirm the generation view has the same reduced controls and hidden-feature behavior as the shared shell.
- Do not use this screenshot as evidence of standalone browser storage, embedded-scene startup, or final delivery appearance.

### Final HTML Gate

For fast delivery, confirm from build output, embedded scene metadata, and strict validators:

- Confirm diagram element colors and styles plus the document background exactly match the source scene and selected Diagram Theme.
- Confirm all source content, geometry, labels, bindings, and files survived generation without runtime restyling or recoloring.
- Confirm each card background and its separate text share group ids, while every relationship connector binds to the card background shape and remains outside the card group.
- Confirm the output remains one self-contained HTML file.

During browser-based full runtime acceptance, additionally:

- Confirm the workspace background and toolbar base state use the selected UI Theme.
- Confirm the `zh-CN` interface, required tools, hidden top-level entries, absence of a custom header, and complete fitted scene.
- Confirm popover, hover, selected, focus, and accent states use the selected UI Theme.
- Confirm shape and arrow tools initially select the theme-derived manual defaults, and that a user override is remembered for that tool without affecting existing elements.
- Draw a new light-filled shape and double-click it: the new bound label must start in brand black rather than inheriting the grey outline. A solid-purple core label must be white. Existing, pasted, and explicitly recolored text must remain unchanged.
- Confirm the `zh-CN` interface, required tools, hidden entries, and absence of a custom header. Confirm the continuous drawing lock and its divider are absent, `Q` cannot enable it outside editable text, and drawing a normal shape returns to selection. Confirm hidden actions stay closed through their keyboard shortcuts, Mermaid paste is rejected, file drop cannot load a scene, and `#addLibrary=` is removed. Confirm that Web Embed cannot be activated or newly created, a pasted URL becomes ordinary text, and existing `embeddable` and legacy `iframe` elements survive save and reload unchanged.
- Confirm the complete scene is visible at a fitted viewport and the screenshot was taken after rendering settled.
- Confirm the fitted viewport appeared automatically on a clean first load, and that reloading an autosaved edit restores its last saved viewport instead of fitting again.

Do not deliver when the checks required by the selected tier fail. Fast delivery does not require opening a browser or full runtime acceptance unless an escalation condition applies.

## Failure routing

- For missing content, truncation, overlap, or bad routing, fix the source scene and repeat describe → export → build.
- For off-token diagram colors or diagram contrast, fix the source scene and repeat validate → build.
- For hand-drawn or unsupported styles, fix the source scene and repeat style validation → build. Do not normalize an imported user scene unless restyling was requested.
- For UI background, toolbar, hover, selected, focus, interface, or shared-runtime issues, fix the UI Theme/template, rebuild it, then repeat both the reduced-workbench check and Final HTML Gate.
- For unexpected old content, first close duplicate standalone tabs and identify the document-specific autosave. Clear it only when preservation is unnecessary. When stale or conflicting autosave must be retained, obtain user approval, rebuild with a new document id, and for `file://` delivery use a new filename as well.
- For an incomplete initial overview, first check for distant accidental elements. If the source bounds are valid, fix the Runtime policy or timing and repeat build → Final HTML Gate.
- Never patch the generated HTML as a one-off visual fix; preserve the `.excalidraw` scene and bundled template as the maintained sources.

## Storage and versioning

- Give each persistent canvas a stable, unique `--id`. Reuse the same id when regenerating that canvas so browser autosave continues to work.
- Treat a material task-palette change as a new theme revision and generate it under a new task-theme id. If old per-tool style memory must not carry forward, obtain approval and build with a new Whiteboard `--id`; rebuilding under the same theme id and document id preserves explicit user overrides and is not a restyle migration.
- Create a new document id only for an explicitly approved recovery from stale or conflicting autosave. For direct `file://` delivery, change both the id and filename so old storage and browser file caching cannot obscure the recovered document.
- Keep only one standalone tab open per document while diagnosing autosave or binding behavior; competing tabs with the same document id can overwrite state and make the active scene ambiguous.
- Keep workbench state canonical in the loopback service; never read or write the standalone document autosave from workbench mode.
- Connect one Workbench tab to one backend during generation and browser export. The upstream service has no document revision or tab targeting, so multiple connected tabs make screenshots, export selection, and concurrent edits ambiguous.
- Store per-tool style memory with the document autosave. Treat missing style memory from older documents as valid and initialize each supported tool from the current embedded defaults on first activation.
- Store the current viewport with the document autosave. A fresh embedded scene uses the initial viewport policy; a returning autosaved scene restores the user's saved camera state.
- Keep the existing build interface backward compatible. `--ui-theme`, `--diagram-theme`, `--theme-manifest`, `--strict-colors`, and `--strict-style` are optional; defaults come from `references/themes/manifest.json`. A task-scoped manifest affects only the command that explicitly receives it.
- The template is pinned to `@excalidraw/excalidraw` 0.18.0. Rebuild and visually verify the template before changing that version because CSS selectors and component behavior may change.
- The maintenance `npm run build` applies a fail-closed reduction patch to that pinned Excalidraw package before bundling, then rejects a template at or above 4,900,000 bytes or one containing removed UI/dependency markers. Run `npm ci` before rebuilding after dependency changes; never bypass the reduction or its verifier.
- The generator requires only Node.js built-ins. Do not run `npm install` for normal Whiteboard HTML generation.
- The source repository's `excalidraw-cn-single/` directory is maintenance source for rebuilding the shared workbench/standalone template; it is intentionally absent from the runtime Plugin package. Keep `index.dev.html` as a data-slot placeholder in that source repository. Its Vite build resolves the default UI Theme and Diagram Theme from `references/themes/manifest.json`. Never hard-code a resolved palette into the maintenance HTML, and never distribute or commit its `node_modules/` or `dist/` directories.

## Scene safety

- The generator escapes `<`, `>`, `&`, and Unicode line separators before embedding scene JSON in HTML.
- Validate that `elements` is an array before generation.
- Preserve element ids, bindings, files, document background, and all element styles and colors. The editor may normalize UI-only state such as closing disabled menus/dialogs, removing a stale file handle, or disabling dark mode when no dark UI tokens exist, but it must never restyle or recolor scene content.
- Keep initial viewport behavior in the fixed Runtime and embedded template policy. Do not add viewport-calculation instructions that make the agent generate editor code or device-specific scale values.
- Apply editor presets only through `currentItem*` app state for future drawing. Guard tool transitions so updating those defaults cannot create an `onChange` loop.
- Correct bound-text color only while a newly created text element is actively being edited. Require both the active editing id and an unseen id; do not infer “new” from an unseen id alone because pasted or loaded elements may also have unseen ids.
- Treat color and style validation as reporting or strict build gates. Never silently replace an off-token user color or a user-owned element style.
- Keep a task-scoped palette spec and generated theme bundle at least in the same directory as the source `.excalidraw` for reproducible rebuilds. The generated standalone HTML embeds the resolved theme and must not depend on the manifest at runtime. If only HTML is delivered for a brand task, list the official source links and research date in the delivery note.
