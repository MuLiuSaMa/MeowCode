# Editable Bindings

Choose the connector mode deliberately.

## Dynamic-Editable Mode

Use this by default when users should be able to drag nodes and have relationships update naturally.

Connector contract:

- exactly two points;
- no intermediate bend points;
- no `fixedPoint` on endpoint bindings;
- a valid `startBinding` and `endBinding`;
- the connector appears in both endpoint nodes' `boundElements`;
- a connector label uses the connector ID as its `containerId`;
- the label appears in the connector's `boundElements`.

Prefer a straight two-point connector for short, unobstructed local relationships. Use a two-point elbowed connector for cross-region routing, obstacle avoidance, or dense card layouts. Elbowed does not authorize fake intermediate bend points: the connector remains endpoint-bound and dynamically editable. Use dashed strokes only for secondary, optional, asynchronous, or mapping relationships.

## Card Group Contract

- For a short single-label card, bound text may be used.
- For a multi-line or richly annotated card, use a background shape plus separate text elements with the same `groupIds`.
- Bind connectors to the background shape that represents the draggable endpoint, never to a card text element or to the group id.
- Keep connectors and connector labels outside the card group.
- Keep the connector in the background shape's `boundElements`, and keep the background shape in the connector's endpoint binding.

## Presentation-Curve Mode

Multi-point curves can create a composed static path, but intermediate points remain anchored in canvas coordinates when endpoint nodes move. They can therefore appear pinned or distorted after editing.

Use presentation curves only when static composition matters more than drag behavior, the limitation is acceptable to the user, and the relationship is not described as fully dynamic.

Do not use label position or intermediate bend points as hidden anchors in a relationship that is expected to reflow.

## Manual Checks

After creating or changing a connected group, inspect shared card/text group ids, shape-targeted endpoint bindings, reverse `boundElements` references, label `containerId`, connector point count, absence of `fixedPoint` in dynamic-editable mode, route choice, and stable IDs after subsequent edits.

These checks belong in the normal describe-and-export pass; they do not require a separate browser session.
