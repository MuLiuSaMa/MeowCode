# Layout Grammar

## Hierarchy

Express priority through area and position, typography and contrast, image scale, whitespace, and connector density.

Use one dominant focal area. As a starting heuristic, it may occupy roughly 45–60% of the attention or usable central area, with supporting regions sharing the remainder. Treat this as a design aid, not a validator rule.

## Grouping

Group by semantic purpose with proximity and alignment first. Add a background region or boundary only when it improves comprehension.

Avoid card-inside-card layouts:

- use at most one visible boundary around a semantic cluster in most cases;
- use whitespace, alignment, headings, and subtle dividers for internal organization;
- do not wrap every sentence or label in its own card.

Treat a card and its separate text as one draggable unit by assigning the same `groupIds` to the background shape and all text elements on it. For a short, single-label card, bound text is also acceptable. Keep relationship connectors outside the card group and bind them to the background shape.

## Images, Shapes, and Text

- Images act as anchors or evidence, not decoration.
- Shapes establish structure and emphasis.
- Text explains what the visual cannot communicate alone.
- Keep supporting labels visually quieter than focal images or claims.
- Maintain a small, consistent type scale, such as 16 for labels, 20 for supporting headings, and 28 or larger for primary headings.

Do not assign images, shapes, and text equal visual weight by default.

For data-heavy canvases, use text to interpret the evidence rather than to carry comparisons that position, length, area, color, or alignment can show directly. Prefer concise labels, separated values, real rows and columns, and visible baselines over inline metric strings. Do not use repeated `|` or `｜` characters as layout.

Give each region one primary claim and one dominant visual cue. Avoid making every module the same size, saturation, border treatment, and typographic weight. Supporting text should be quieter than the value, comparison, or finding it explains.

Use corner radius as a restrained system rather than decoration. Keep comparable surfaces consistent, avoid pill-like panels unless the shape has a semantic purpose, and honor an explicit user radius as a pixel cap through adaptive roundness. A professional canvas can use either near-square or softly rounded surfaces; consistency and proportion matter more than maximizing curvature.

## Reading Path

Make the path understandable from layout alone. Emphasize the entry point, align related regions, preserve generous gaps between different purposes, and avoid crossing the primary reading corridor with decorative lines.

## Connector Discipline

Use a connector only when its source, target, and relationship are meaningful. Do not connect items merely because the reader encounters them in sequence. Keep relationship networks local, and use labels only when they add meaning that endpoints do not already convey.

Choose the simplest route that remains legible:

- use a straight connector for short, local, unobstructed relationships;
- use a two-point elbowed connector for cross-region paths, obstacle avoidance, or dense card layouts;
- use dashed strokes for secondary, optional, asynchronous, or mapping relationships rather than as decoration;
- use a presentation curve only when straight and elbowed routing cannot express a composed static fan-out.
