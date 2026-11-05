const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const LABEL_CONTAINER_TYPES = new Set([...SHAPE_TYPES, "arrow", "line"]);
const LINEAR_TYPES = new Set(["arrow", "line"]);

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stablePositiveInteger(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483646 + 1;
}

function normalizedFontFamily(value) {
  if (Number.isInteger(Number(value))) {
    return Number(value);
  }
  const key = String(value || "").toLowerCase();
  const aliases = {
    virgil: 1,
    hand: 1,
    handwritten: 1,
    helvetica: 2,
    sans: 2,
    "sans-serif": 2,
    cascadia: 3,
    mono: 3,
    monospace: 3,
    excalifont: 5,
    nunito: 6,
    lilita: 7,
    "lilita-one": 7,
    comic: 8,
    "comic-shanns": 8
  };
  return aliases[key] || 2;
}

function normalizedPoints(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return [[0, 0], [100, 0]];
  }
  return points.map((point) => {
    if (Array.isArray(point)) {
      return [
        finiteNumber(point[0], 0),
        finiteNumber(point[1], 0)
      ];
    }
    return [
      finiteNumber(point?.x, 0),
      finiteNumber(point?.y, 0)
    ];
  });
}

function pointBounds(points) {
  const normalized = normalizedPoints(points);
  const xValues = normalized.map(([x]) => x);
  const yValues = normalized.map(([, y]) => y);
  return {
    points: normalized,
    width: Math.max(...xValues) - Math.min(...xValues),
    height: Math.max(...yValues) - Math.min(...yValues)
  };
}

function textMetrics(text, fontSize, lineHeight, maxWidth = Infinity) {
  const lines = String(text).split(/\r?\n/);
  const measuredWidth = Math.max(
    1,
    ...lines.map((line) =>
      [...line].reduce(
        (width, character) =>
          width + fontSize * (character.codePointAt(0) > 0x7f ? 1 : 0.62),
        0
      )
    )
  );
  return {
    width: Math.max(1, Math.min(measuredWidth, maxWidth)),
    height: Math.max(fontSize * lineHeight, lines.length * fontSize * lineHeight)
  };
}

function uniqueId(base, occupiedIds) {
  let candidate = base;
  let suffix = 2;
  while (occupiedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  occupiedIds.add(candidate);
  return candidate;
}

function textColorFor(element, label, options) {
  if (typeof label?.strokeColor === "string") {
    return label.strokeColor;
  }
  const background = String(element.backgroundColor || "");
  const mapping = options.labelColorsByBackground || {};
  return (
    mapping[background] ||
    mapping[background.toLowerCase()] ||
    mapping[background.toUpperCase()] ||
    options.defaultTextColor ||
    "#0A0A0A"
  );
}

function normalizeBaseElement(element, index) {
  const {
    createdAt,
    updatedAt,
    syncedAt,
    source,
    syncTimestamp,
    label,
    start,
    end,
    text,
    ...rest
  } = element;
  const id = String(rest.id || `canvas-element-${index + 1}`);
  const type = rest.type;
  const base = {
    ...rest,
    id,
    type,
    x: finiteNumber(rest.x, 0),
    y: finiteNumber(rest.y, 0),
    angle: finiteNumber(rest.angle, 0),
    strokeColor: rest.strokeColor || "#0A0A0A",
    backgroundColor: rest.backgroundColor || "transparent",
    fillStyle: rest.fillStyle || "solid",
    strokeWidth: finiteNumber(rest.strokeWidth, 1),
    strokeStyle: rest.strokeStyle || "solid",
    roughness: finiteNumber(rest.roughness, 0),
    opacity: finiteNumber(rest.opacity, 100),
    groupIds: Array.isArray(rest.groupIds) ? [...rest.groupIds] : [],
    frameId: rest.frameId ?? null,
    index: rest.index || `a${index.toString(36)}`,
    roundness:
      rest.roundness !== undefined
        ? rest.roundness
        : SHAPE_TYPES.has(type)
          ? { type: 3 }
          : null,
    seed: finiteNumber(rest.seed, stablePositiveInteger(`${id}:seed`)),
    version: finiteNumber(rest.version, 1),
    versionNonce: finiteNumber(
      rest.versionNonce,
      stablePositiveInteger(`${id}:version`)
    ),
    isDeleted: rest.isDeleted === true,
    boundElements: Array.isArray(rest.boundElements)
      ? rest.boundElements.map((binding) => ({ ...binding }))
      : null,
    updated:
      finiteNumber(rest.updated, Number.NaN) ||
      (Number.isFinite(Date.parse(updatedAt)) ? Date.parse(updatedAt) : 1),
    link: rest.link ?? null,
    locked: rest.locked === true
  };

  if (SHAPE_TYPES.has(type) || type === "image") {
    base.width = finiteNumber(rest.width, 100);
    base.height = finiteNumber(rest.height, 100);
  }

  if (LINEAR_TYPES.has(type)) {
    const bounds = pointBounds(rest.points);
    base.points = bounds.points;
    base.width = finiteNumber(rest.width, bounds.width);
    base.height = finiteNumber(rest.height, bounds.height);
    base.lastCommittedPoint = rest.lastCommittedPoint ?? null;
    base.startBinding = rest.startBinding ?? null;
    base.endBinding = rest.endBinding ?? null;
    base.startArrowhead = rest.startArrowhead ?? null;
    base.endArrowhead =
      rest.endArrowhead !== undefined
        ? rest.endArrowhead
        : type === "arrow"
          ? "arrow"
          : null;
    base.elbowed = rest.elbowed === true;
  }

  if (type === "freedraw") {
    base.points = normalizedPoints(rest.points);
    base.pressures = Array.isArray(rest.pressures) ? [...rest.pressures] : [];
    base.simulatePressure = rest.simulatePressure !== false;
    base.lastCommittedPoint = rest.lastCommittedPoint ?? null;
  }

  if (type === "image") {
    base.status = rest.status || "saved";
    base.scale = Array.isArray(rest.scale) ? [...rest.scale] : [1, 1];
  }

  if (type === "text") {
    const value = String(text ?? rest.originalText ?? "");
    const fontSize = finiteNumber(rest.fontSize, 16);
    const fontFamily = normalizedFontFamily(rest.fontFamily);
    const lineHeight = finiteNumber(rest.lineHeight, 1.25);
    const metrics = textMetrics(value, fontSize, lineHeight);
    base.width = finiteNumber(rest.width, metrics.width);
    base.height = finiteNumber(rest.height, metrics.height);
    base.text = value;
    base.originalText = String(rest.originalText ?? value);
    base.fontSize = fontSize;
    base.fontFamily = fontFamily;
    base.textAlign = rest.textAlign || "left";
    base.verticalAlign = rest.verticalAlign || "top";
    base.autoResize = rest.autoResize !== false;
    base.lineHeight = lineHeight;
    base.containerId = rest.containerId ?? null;
  }

  return {
    base,
    label,
    labelText:
      LABEL_CONTAINER_TYPES.has(type) && (label?.text || text)
        ? String(label?.text || text)
        : ""
  };
}

function createBoundText(container, label, labelText, id, index, options) {
  const fontSize = finiteNumber(label?.fontSize ?? container.fontSize, 16);
  const fontFamily = normalizedFontFamily(
    label?.fontFamily ?? container.fontFamily
  );
  const lineHeight = finiteNumber(label?.lineHeight, 1.25);
  const isLinear = LINEAR_TYPES.has(container.type);
  let x;
  let y;
  let metrics;

  if (isLinear) {
    const points = normalizedPoints(container.points);
    const end = points.at(-1);
    metrics = textMetrics(labelText, fontSize, lineHeight);
    x = container.x + end[0] / 2 - metrics.width / 2;
    y = container.y + end[1] / 2 - metrics.height / 2;
  } else {
    const availableWidth = Math.max(1, finiteNumber(container.width, 100) - 20);
    metrics = textMetrics(labelText, fontSize, lineHeight, availableWidth);
    x =
      container.x +
      (finiteNumber(container.width, 100) - metrics.width) / 2;
    y =
      container.y +
      (finiteNumber(container.height, 100) - metrics.height) / 2;
  }

  return {
    id,
    type: "text",
    x,
    y,
    width: metrics.width,
    height: metrics.height,
    angle: container.angle,
    strokeColor: textColorFor(container, label, options),
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [...(container.groupIds || [])],
    frameId: container.frameId ?? null,
    index: `a${index.toString(36)}`,
    roundness: null,
    seed: stablePositiveInteger(`${id}:seed`),
    version: 1,
    versionNonce: stablePositiveInteger(`${id}:version`),
    isDeleted: container.isDeleted,
    boundElements: null,
    updated: container.updated,
    link: null,
    locked: container.locked,
    text: labelText,
    originalText: labelText,
    fontSize,
    fontFamily,
    textAlign: "center",
    verticalAlign: "middle",
    autoResize: true,
    lineHeight,
    containerId: container.id
  };
}

export function normalizeExportedScene(scene, options = {}) {
  if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements)) {
    throw new Error("场景文件无效：缺少 elements 数组");
  }

  const needsCompatibilityNormalization =
    scene.source === "mcp-excalidraw-server" ||
    scene.elements.some(
      (element) =>
        element &&
        typeof element === "object" &&
        (Object.hasOwn(element, "label") ||
          Object.hasOwn(element, "start") ||
          Object.hasOwn(element, "end") ||
          Object.hasOwn(element, "createdAt") ||
          Object.hasOwn(element, "updatedAt"))
  );
  if (!needsCompatibilityNormalization) {
    const output = structuredClone(scene);
    if (
      (output.appState?.viewBackgroundColor == null ||
        output.appState.viewBackgroundColor === "") &&
      options.documentBackground
    ) {
      output.appState = {
        ...(output.appState || {}),
        viewBackgroundColor: options.documentBackground
      };
    }
    return output;
  }

  const records = scene.elements.map(normalizeBaseElement);
  const occupiedIds = new Set(records.map(({ base }) => base.id));
  const existingTextByContainer = new Map(
    records
      .filter(({ base }) => base.type === "text" && base.containerId)
      .map(({ base }) => [base.containerId, base.id])
  );
  const generatedText = [];

  for (const { base, label, labelText } of records) {
    const existingTextId =
      existingTextByContainer.get(base.id) ||
      base.boundElements?.find(
        (binding) =>
          binding?.type === "text" && occupiedIds.has(binding.id)
      )?.id;
    base.boundElements = base.boundElements
      ? base.boundElements.filter(
          (binding) => binding?.id && occupiedIds.has(binding.id)
        )
      : null;

    if (!labelText || existingTextId) {
      continue;
    }

    const textId = uniqueId(`${base.id}-label`, occupiedIds);
    base.boundElements = [
      ...(base.boundElements || []),
      { type: "text", id: textId }
    ];
    generatedText.push(
      createBoundText(
        base,
        label,
        labelText,
        textId,
        records.length + generatedText.length,
        options
      )
    );
  }

  const boundArrows = new Map();
  for (const { base } of records) {
    if (!LINEAR_TYPES.has(base.type)) {
      continue;
    }
    for (const binding of [base.startBinding, base.endBinding]) {
      if (!binding?.elementId || !occupiedIds.has(binding.elementId)) {
        continue;
      }
      const current = boundArrows.get(binding.elementId) || [];
      if (!current.some((item) => item.id === base.id)) {
        current.push({ type: "arrow", id: base.id });
      }
      boundArrows.set(binding.elementId, current);
    }
  }
  for (const { base } of records) {
    const arrows = boundArrows.get(base.id);
    if (arrows) {
      const bindings = [...(base.boundElements || []), ...arrows];
      base.boundElements = [
        ...new Map(
          bindings.map((binding) => [
            `${binding.type}:${binding.id}`,
            binding
          ])
        ).values()
      ];
    }
  }

  return {
    ...scene,
    type: scene.type || "excalidraw",
    version: finiteNumber(scene.version, 2),
    source: "canvas-plugin-compat",
    elements: [...records.map(({ base }) => base), ...generatedText],
    appState: {
      ...(scene.appState || {}),
      ...((scene.appState?.viewBackgroundColor == null ||
        scene.appState.viewBackgroundColor === "") &&
      options.documentBackground
        ? { viewBackgroundColor: options.documentBackground }
        : {})
    },
    files: scene.files && typeof scene.files === "object" ? scene.files : {}
  };
}
