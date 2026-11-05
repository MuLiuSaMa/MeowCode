# Iteration Policy

## Source of Truth

Treat `.excalidraw` as the editable source of truth. Treat self-contained HTML as the required default user-facing delivery artifact unless the user explicitly requests source-only output.

Inspect and edit the source scene, preserve element, file, group, and binding IDs, and regenerate the HTML from the updated scene. Deliver that regenerated HTML first. Do not infer the latest editable state solely from visual appearance.

## Patch, Do Not Redraw

For an existing canvas:

- change existing elements by stable ID;
- keep unaffected regions intact;
- preserve groups, embedded files, and bindings;
- create a new element only when the requested concept is genuinely new;
- do not create a parallel HTML file for a local edit unless the user asks for a versioned copy.

Apply related edits in one coherent batch, then run one structural describe and the relevant built-in validators.

## Interpret Visual Feedback Literally

- Change only the visual variables named by the user unless the requested change requires a dependent adjustment.
- Treat “all,” “uniform,” and “overall” as instructions to update the complete intended element set, not a sample of elements.
- Preserve content, layout, and palette while comparing values such as 2px, 8px, and 16px corner radii.
- Use the element model's actual semantics. For an exact Excalidraw rectangle radius, use adaptive roundness with the requested pixel cap; do not substitute legacy proportional roundness.
- If the user says the result looks unchanged, check the applied element properties, parameter semantics, document autosave, and browser file caching before redesigning the canvas.
- Do not create a chain of new standalone documents for ordinary iteration. Keep the document identity stable unless a stale or conflicting autosave requires a clean identity and the user approves that recovery.

## Wireframes and Completion

An internal layout frame is a planning device. Unless the user explicitly requests a wireframe, continue from the frame to a complete canvas with the requested information.

## Browser Use

Browser preview is opt-in. Use it only when the user requests visual inspection or when compatibility-sensitive HTML behavior cannot be established structurally.

## Document Identity and Autosave

Keep document identity stable during normal iterations. Do not silently change the document ID or discard browser-saved edits. If an embedded source revision must replace stale autosave state, first close duplicate tabs for that document and identify the conflict. Explain why a clean document identity or explicit reset is necessary before doing so.
