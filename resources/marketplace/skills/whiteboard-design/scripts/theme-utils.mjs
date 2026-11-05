import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_THEME_MANIFEST = path.resolve(
  SCRIPT_DIRECTORY,
  "../references/themes/manifest.json"
);

const UI_TOKEN_TO_CSS_VARIABLE = {
  "workspace.background": "--canvas-ui-workspace",
  "toolbar.background": "--canvas-ui-toolbar",
  "popover.background": "--canvas-ui-popover",
  "surface.tertiary": "--canvas-ui-surface-tertiary",
  "surface.overlay": "--canvas-ui-overlay",
  "surface.overlayStrong": "--canvas-ui-overlay-strong",
  "border.default": "--canvas-ui-border",
  "border.hover": "--canvas-ui-border-hover",
  "border.strong": "--canvas-ui-border-strong",
  "text.primary": "--canvas-ui-text-primary",
  "text.secondary": "--canvas-ui-text-secondary",
  "text.tertiary": "--canvas-ui-text-tertiary",
  "text.disabled": "--canvas-ui-text-disabled",
  "text.inverse": "--canvas-ui-text-inverse",
  "text.link": "--canvas-ui-link",
  "text.linkHover": "--canvas-ui-link-hover",
  "icon.primary": "--canvas-ui-icon-primary",
  "icon.disabled": "--canvas-ui-icon-disabled",
  "icon.inverse": "--canvas-ui-icon-inverse",
  "action.primary": "--canvas-ui-accent",
  "action.primaryHover": "--canvas-ui-accent-hover",
  "action.primaryPressed": "--canvas-ui-accent-pressed",
  "action.disabled": "--canvas-ui-action-disabled",
  "action.hover": "--canvas-ui-hover",
  "action.selected": "--canvas-ui-selected",
  "action.selectedText": "--canvas-ui-selected-text",
  "focus.ring": "--canvas-ui-focus-ring",
  "scrollbar.default": "--canvas-ui-scrollbar",
  "scrollbar.hover": "--canvas-ui-scrollbar-hover",
  "slider.trackActive": "--canvas-ui-slider-track-active",
  "slider.trackInactive": "--canvas-ui-slider-track-inactive",
  "slider.thumb": "--canvas-ui-slider-thumb",
  "status.success.default": "--canvas-ui-success",
  "status.success.hover": "--canvas-ui-success-hover",
  "status.success.pressed": "--canvas-ui-success-pressed",
  "status.success.surface1": "--canvas-ui-success-surface-1",
  "status.success.surface2": "--canvas-ui-success-surface-2",
  "status.success.surface3": "--canvas-ui-success-surface-3",
  "status.warning.default": "--canvas-ui-warning",
  "status.warning.hover": "--canvas-ui-warning-hover",
  "status.warning.pressed": "--canvas-ui-warning-pressed",
  "status.warning.surface1": "--canvas-ui-warning-surface-1",
  "status.warning.surface2": "--canvas-ui-warning-surface-2",
  "status.warning.surface3": "--canvas-ui-warning-surface-3",
  "status.danger.default": "--canvas-ui-danger",
  "status.danger.hover": "--canvas-ui-danger-hover",
  "status.danger.pressed": "--canvas-ui-danger-pressed",
  "status.danger.surface1": "--canvas-ui-danger-surface-1",
  "status.danger.surface2": "--canvas-ui-danger-surface-2",
  "status.danger.surface3": "--canvas-ui-danger-surface-3",
  "shadow.color": "--canvas-ui-shadow-color"
};

const UI_TOKEN_FALLBACKS = {
  "surface.tertiary": "action.hover",
  "surface.overlay": "action.selected",
  "surface.overlayStrong": "action.selected",
  "border.hover": "border.default",
  "border.strong": "border.default",
  "text.tertiary": "text.secondary",
  "text.disabled": "text.secondary",
  "text.inverse": "toolbar.background",
  "text.link": "action.primary",
  "text.linkHover": "action.primaryHover",
  "icon.primary": "text.primary",
  "icon.disabled": "text.secondary",
  "icon.inverse": "toolbar.background",
  "action.disabled": "action.selected",
  "scrollbar.default": "action.selected",
  "scrollbar.hover": "action.selected",
  "slider.trackActive": "action.primary",
  "slider.trackInactive": "surface.tertiary",
  "slider.thumb": "action.primary",
  "status.success.default": "action.primary",
  "status.success.hover": "action.primaryHover",
  "status.success.pressed": "action.primaryPressed",
  "status.success.surface1": "action.selected",
  "status.success.surface2": "action.selected",
  "status.success.surface3": "action.selected",
  "status.warning.default": "action.primary",
  "status.warning.hover": "action.primaryHover",
  "status.warning.pressed": "action.primaryPressed",
  "status.warning.surface1": "action.selected",
  "status.warning.surface2": "action.selected",
  "status.warning.surface3": "action.selected",
  "status.danger.default": "action.primary",
  "status.danger.hover": "action.primaryHover",
  "status.danger.pressed": "action.primaryPressed",
  "status.danger.surface1": "action.selected",
  "status.danger.surface2": "action.selected",
  "status.danger.surface3": "action.selected",
  "shadow.color": "text.primary"
};

const COLOR_PATTERN = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const TOKEN_REFERENCE_PATTERN = /^\{([^{}]+)\}$/;

async function readJson(filePath, label) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} 无法读取：${filePath}（${error.message}）`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${filePath}（${error.message}）`);
  }
}

function assertColor(value, label) {
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
    throw new Error(`${label} 必须是 6 位或 8 位十六进制颜色，当前值：${value}`);
  }
}

function assertColorTree(value, label) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertColorTree(entry, `${label}.${index + 1}`)
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertColorTree(entry, `${label}.${key}`);
    }
    return;
  }
  assertColor(value, label);
}

export function resolveTokenReferences(value, primitives, stack = []) {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveTokenReferences(entry, primitives, stack));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveTokenReferences(entry, primitives, stack)
      ])
    );
  }

  if (typeof value !== "string") {
    return value;
  }

  const match = value.match(TOKEN_REFERENCE_PATTERN);
  if (!match) {
    return value;
  }

  const tokenName = match[1];
  if (!(tokenName in primitives)) {
    throw new Error(`未知 Token 引用：${tokenName}`);
  }
  if (stack.includes(tokenName)) {
    throw new Error(`循环 Token 引用：${[...stack, tokenName].join(" -> ")}`);
  }

  return resolveTokenReferences(primitives[tokenName], primitives, [
    ...stack,
    tokenName
  ]);
}

export async function loadThemeManifest(manifestPath = DEFAULT_THEME_MANIFEST) {
  const absolutePath = path.resolve(manifestPath);
  const manifest = await readJson(absolutePath, "主题清单");

  if (!manifest || typeof manifest !== "object") {
    throw new Error("主题清单必须是对象");
  }
  if (!manifest.primitives) {
    throw new Error("主题清单缺少 primitives");
  }
  if (!manifest.defaultUiTheme || !manifest.defaultDiagramTheme) {
    throw new Error("主题清单缺少默认 UI 或图表主题");
  }

  return { manifest, manifestPath: absolutePath };
}

async function resolveTheme(kind, requestedId, manifestPath) {
  const { manifest, manifestPath: absoluteManifestPath } =
    await loadThemeManifest(manifestPath);
  const manifestDirectory = path.dirname(absoluteManifestPath);
  const primitivePath = path.resolve(manifestDirectory, manifest.primitives);
  const primitives = await readJson(primitivePath, "品牌基础 Token");
  const isUiTheme = kind === "ui";
  const collection = isUiTheme ? manifest.uiThemes : manifest.diagramThemes;
  const aliases = isUiTheme
    ? manifest.uiThemeAliases
    : manifest.diagramThemeAliases;
  const defaultId = isUiTheme
    ? manifest.defaultUiTheme
    : manifest.defaultDiagramTheme;
  const requestedThemeId = requestedId || defaultId;
  const themeId = aliases?.[requestedThemeId] || requestedThemeId;

  if (!collection || !collection[themeId]) {
    const available = Object.keys(collection || {}).join(", ") || "无";
    throw new Error(`未知${isUiTheme ? " UI" : "图表"}主题：${requestedThemeId}。可用主题：${available}`);
  }

  const themePath = path.resolve(manifestDirectory, collection[themeId]);
  const unresolvedTheme = await readJson(
    themePath,
    isUiTheme ? "UI Theme" : "Diagram Theme"
  );
  const theme = resolveTokenReferences(unresolvedTheme, primitives);

  if (theme.id !== themeId) {
    throw new Error(`主题 id 与清单不一致：期望 ${themeId}，实际 ${theme.id}`);
  }

  return theme;
}

export async function resolveUiTheme(
  themeId,
  manifestPath = DEFAULT_THEME_MANIFEST
) {
  const theme = await resolveTheme("ui", themeId, manifestPath);
  if (!theme.light || typeof theme.light !== "object") {
    throw new Error(`UI Theme ${theme.id} 缺少 light Token`);
  }

  const light = { ...theme.light };

  for (const [tokenName, fallbackToken] of Object.entries(
    UI_TOKEN_FALLBACKS
  )) {
    if (!(tokenName in light) && fallbackToken in light) {
      light[tokenName] = light[fallbackToken];
    }
  }

  for (const tokenName of Object.keys(UI_TOKEN_TO_CSS_VARIABLE)) {
    if (!(tokenName in light)) {
      throw new Error(`UI Theme ${theme.id} 缺少 Token：${tokenName}`);
    }
    assertColor(light[tokenName], `UI Token ${tokenName}`);
  }

  return { ...theme, light };
}

export async function resolveDiagramTheme(
  themeId,
  manifestPath = DEFAULT_THEME_MANIFEST
) {
  const theme = await resolveTheme("diagram", themeId, manifestPath);
  const requiredColors = [
    ["document.background", theme.document?.background],
    ["document.text", theme.document?.text],
    ["document.connector", theme.document?.connector],
    ["node.neutral.fill", theme.node?.neutral?.fill],
    ["node.neutral.stroke", theme.node?.neutral?.stroke],
    ["node.primary.fill", theme.node?.primary?.fill],
    ["node.primary.stroke", theme.node?.primary?.stroke]
  ];

  for (const [tokenName, color] of requiredColors) {
    assertColor(color, `Diagram Token ${tokenName}`);
  }
  if (!Array.isArray(theme.series) || theme.series.length === 0) {
    throw new Error(`Diagram Theme ${theme.id} 缺少 series 色板`);
  }
  assertColorTree(theme.document, "Diagram Token document");
  assertColorTree(theme.node, "Diagram Token node");
  assertColorTree(theme.semantic, "Diagram Token semantic");
  assertColorTree(theme.series, "Diagram Token series");
  if (theme.data !== undefined) {
    assertColorTree(theme.data, "Diagram Token data");
    if (
      theme.data.labelRoles !== undefined &&
      !Array.isArray(theme.data.labelRoles)
    ) {
      throw new Error(`Diagram Theme ${theme.id} 的 data.labelRoles 必须是数组`);
    }
  }

  diagramBoundTextColorsByBackground(theme);

  if (theme.style !== undefined) {
    const requiredStyleValues = [
      ["style.shape.roughness", theme.style?.shape?.roughness, 0],
      ["style.shape.strokeWidth", theme.style?.shape?.strokeWidth, 1],
      ["style.shape.strokeStyle", theme.style?.shape?.strokeStyle, "solid"],
      ["style.shape.fillStyle", theme.style?.shape?.fillStyle, "solid"],
      ["style.text.fontFamily", theme.style?.text?.fontFamily, "helvetica"],
      ["style.arrow.route", theme.style?.arrow?.route, "straight"],
      ["style.arrow.endArrowhead", theme.style?.arrow?.endArrowhead, "triangle"]
    ];
    for (const [tokenName, value, expected] of requiredStyleValues) {
      if (value !== expected) {
        throw new Error(`Diagram Theme ${theme.id} 的 ${tokenName} 必须是 ${expected}`);
      }
    }
    for (const tokenName of [
      "strokeWidths",
      "strokeStyles",
      "rectangleRoundnessTypes",
      "arrowRoutes",
      "arrowheads"
    ]) {
      if (!Array.isArray(theme.style?.allowed?.[tokenName])) {
        throw new Error(`Diagram Theme ${theme.id} 缺少 style.allowed.${tokenName}`);
      }
    }
  }

  return theme;
}

export function uiThemeToCssVariables(theme) {
  if (!theme?.light) {
    throw new Error("UI Theme 缺少 light Token");
  }

  return Object.fromEntries(
    Object.entries(UI_TOKEN_TO_CSS_VARIABLE).map(([tokenName, variableName]) => {
      const value = theme.light[tokenName];
      assertColor(value, `UI Token ${tokenName}`);
      return [variableName, value];
    })
  );
}

function collectThemeColors(value, colors = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectThemeColors(entry, colors));
    return colors;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => collectThemeColors(entry, colors));
    return colors;
  }
  if (typeof value === "string" && COLOR_PATTERN.test(value)) {
    colors.add(value.toLowerCase());
  }
  return colors;
}

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const CONNECTOR_TYPES = new Set(["arrow", "line"]);

function nodeRolesByFill(diagramTheme) {
  const rolesByFill = new Map();
  for (const [roleName, role] of Object.entries(diagramTheme.node || {})) {
    if (!role?.fill || !role.stroke || !role.text) {
      continue;
    }
    const fillKey = role.fill.toLowerCase();
    const existing = rolesByFill.get(fillKey);
    if (
      existing &&
      (existing.stroke.toLowerCase() !== role.stroke.toLowerCase() ||
        existing.text.toLowerCase() !== role.text.toLowerCase())
    ) {
      throw new Error(
        `Diagram Theme ${diagramTheme.id} 的节点角色 ${existing.roleName} 与 ${roleName} 使用相同 fill，但 stroke 或 text 不一致`
      );
    }
    rolesByFill.set(fillKey, { ...role, roleName });
  }
  return rolesByFill;
}

export function diagramBoundTextColorsByBackground(diagramTheme) {
  const mapping = {};
  const roleEntries = [
    ...Object.entries(diagramTheme.node || {}).map(([name, role]) => ({
      name: `node.${name}`,
      role
    })),
    ...(diagramTheme.data?.labelRoles || []).map((role, index) => ({
      name: `data.labelRoles[${index}]`,
      role
    }))
  ];

  for (const { name, role } of roleEntries) {
    if (!role?.fill || !role.text) {
      continue;
    }
    const fill = role.fill.toUpperCase();
    const existing = mapping[fill];
    if (existing && existing.toLowerCase() !== role.text.toLowerCase()) {
      throw new Error(
        `Diagram Theme ${diagramTheme.id} 的 ${name} 与其他角色使用相同 fill，但 text 不一致`
      );
    }
    mapping[fill] = role.text;
  }

  return mapping;
}

export function validateSceneColors(scene, diagramTheme) {
  if (!scene || !Array.isArray(scene.elements)) {
    throw new Error("场景文件无效：缺少 elements 数组");
  }

  const allowedColors = collectThemeColors({
    document: diagramTheme.document,
    node: diagramTheme.node,
    data: diagramTheme.data,
    semantic: diagramTheme.semantic,
    series: diagramTheme.series
  });
  allowedColors.add("transparent");
  const violations = [];
  const elementsById = new Map(
    scene.elements
      .filter((element) => element?.id)
      .map((element) => [element.id, element])
  );
  const nodeRoleMap = nodeRolesByFill(diagramTheme);
  const boundTextColorsByBackground = new Map(
    Object.entries(diagramBoundTextColorsByBackground(diagramTheme)).map(
      ([fill, text]) => [fill.toLowerCase(), text]
    )
  );
  const connectorColors = [
    diagramTheme.document?.connector,
    diagramTheme.document?.primaryConnector
  ].filter(Boolean);
  const connectorColorKeys = new Set(
    connectorColors.map((color) => color.toLowerCase())
  );
  const dataColors = [
    ...(diagramTheme.series || []),
    diagramTheme.data?.other,
    ...(diagramTheme.data?.accents || [])
  ].filter((color) => typeof color === "string");
  const dataColorKeys = new Set(
    dataColors.map((color) => color.toLowerCase())
  );
  const semanticColorKeys = collectThemeColors(diagramTheme.semantic || {});
  const documentBackground = scene.appState?.viewBackgroundColor;
  const expectedDocumentBackground = diagramTheme.document?.background;

  if (
    typeof expectedDocumentBackground === "string" &&
    (typeof documentBackground !== "string" ||
      documentBackground.toLowerCase() !==
        expectedDocumentBackground.toLowerCase())
  ) {
    violations.push({
      elementId: "(appState)",
      property: "appState.viewBackgroundColor",
      value: documentBackground ?? null,
      expected: expectedDocumentBackground,
      reason: "document-background"
    });
  }

  for (const element of scene.elements) {
    for (const property of ["strokeColor", "backgroundColor"]) {
      const value = element?.[property];
      if (
        property === "backgroundColor" &&
        SHAPE_TYPES.has(element?.type) &&
        (value === null ||
          value === undefined ||
          value === "" ||
          value.toLowerCase?.() === "transparent")
      ) {
        violations.push({
          elementId: element?.id || "(missing-id)",
          property,
          value: value ?? null
        });
        continue;
      }
      if (value === null || value === undefined || value === "") {
        continue;
      }
      if (
        typeof value !== "string" ||
        !allowedColors.has(value.toLowerCase())
      ) {
        violations.push({
          elementId: element?.id || "(missing-id)",
          property,
          value
        });
      }
    }

    const strokeColorKey =
      typeof element?.strokeColor === "string"
        ? element.strokeColor.toLowerCase()
        : null;
    const backgroundColorKey =
      typeof element?.backgroundColor === "string"
        ? element.backgroundColor.toLowerCase()
        : null;

    if (SHAPE_TYPES.has(element?.type)) {
      const role = nodeRoleMap.get(backgroundColorKey);
      if (
        role &&
        allowedColors.has(strokeColorKey) &&
        strokeColorKey !== role.stroke.toLowerCase()
      ) {
        violations.push({
          elementId: element?.id || "(missing-id)",
          property: "strokeColor",
          value: element.strokeColor,
          expected: role.stroke,
          reason: "node-role"
        });
      }
    }

    if (CONNECTOR_TYPES.has(element?.type) && allowedColors.has(strokeColorKey)) {
      const declaredRole = element.customData?.canvasColorRole;
      const isTaggedDataLine =
        element.type === "line" && declaredRole === "data-series";
      const isTaggedSemanticLine =
        element.type === "line" && declaredRole === "semantic-status";
      const expectedColorKeys = isTaggedDataLine
        ? dataColorKeys
        : isTaggedSemanticLine
          ? semanticColorKeys
          : connectorColorKeys;
      const expectedColors = isTaggedDataLine
        ? dataColors
        : isTaggedSemanticLine
          ? [...semanticColorKeys]
          : connectorColors;

      if (!expectedColorKeys.has(strokeColorKey)) {
        violations.push({
          elementId: element?.id || "(missing-id)",
          property: "strokeColor",
          value: element.strokeColor,
          expected: expectedColors,
          reason: isTaggedDataLine
            ? "data-series-role"
            : isTaggedSemanticLine
              ? "semantic-status-role"
              : "connector-role"
        });
      }
    }

    if (element?.type === "text" && element.containerId) {
      const container = elementsById.get(element.containerId);
      const expectedTextColor = boundTextColorsByBackground.get(
        typeof container?.backgroundColor === "string"
          ? container.backgroundColor.toLowerCase()
          : null
      );
      if (
        expectedTextColor &&
        allowedColors.has(strokeColorKey) &&
        strokeColorKey !== expectedTextColor.toLowerCase()
      ) {
        violations.push({
          elementId: element?.id || "(missing-id)",
          property: "strokeColor",
          value: element.strokeColor,
          expected: expectedTextColor,
          reason: "bound-text-role"
        });
      }
    }
  }

  return {
    themeId: diagramTheme.id,
    checkedElements: scene.elements.length,
    violations
  };
}

const hasOwn = (value, property) =>
  Object.prototype.hasOwnProperty.call(value, property);

function classifyArrowRoute(element) {
  if (element.elbowed === true) {
    return "elbowed";
  }
  if (element.roundness == null && (!Array.isArray(element.points) || element.points.length <= 2)) {
    return "straight";
  }
  if (element.roundness?.type === 2 && Array.isArray(element.points) && element.points.length >= 3) {
    return "curved";
  }
  return "unsupported";
}

export function validateSceneStyles(scene, diagramTheme) {
  if (!scene || !Array.isArray(scene.elements)) {
    throw new Error("场景文件无效：缺少 elements 数组");
  }
  if (!diagramTheme?.style) {
    throw new Error("Diagram Theme 缺少 style 配置");
  }

  const { shape, text, arrow, allowed } = diagramTheme.style;
  const violations = [];
  const warnings = [];
  const elementsById = new Map(
    scene.elements
      .filter((element) => element?.id)
      .map((element) => [element.id, element])
  );
  const allowedTextSizes = [
    text.fontSize,
    text.groupTitleFontSize,
    text.titleFontSize
  ].filter(Number.isFinite);
  const addViolation = (element, property, value, expected) => {
    violations.push({
      elementId: element?.id || "(missing-id)",
      property,
      value,
      expected
    });
  };
  const addWarning = (element, property, value, defaultValue, reason) => {
    warnings.push({
      elementId: element?.id || "(missing-id)",
      property,
      value,
      defaultValue,
      reason
    });
  };

  for (const element of scene.elements) {
    if (!element || typeof element !== "object") {
      addViolation(element, "element", element, "object");
      continue;
    }
    if (element.type === "freedraw") {
      addViolation(element, "type", element.type, "non-freedraw diagram element");
      continue;
    }

    const isShape = SHAPE_TYPES.has(element.type);
    const isConnector = CONNECTOR_TYPES.has(element.type);
    if (isShape || isConnector) {
      const defaults = element.type === "arrow" ? arrow : shape;

      if (element.roughness !== 0) {
        addViolation(element, "roughness", element.roughness, 0);
      }
      if (!allowed.strokeWidths.includes(element.strokeWidth)) {
        addViolation(element, "strokeWidth", element.strokeWidth, allowed.strokeWidths);
      } else if (element.strokeWidth !== defaults.strokeWidth) {
        addWarning(
          element,
          "strokeWidth",
          element.strokeWidth,
          defaults.strokeWidth,
          "仅用于核心路径或重点节点"
        );
      }
      if (!allowed.strokeStyles.includes(element.strokeStyle)) {
        addViolation(element, "strokeStyle", element.strokeStyle, allowed.strokeStyles);
      } else if (element.strokeStyle !== defaults.strokeStyle) {
        addWarning(
          element,
          "strokeStyle",
          element.strokeStyle,
          defaults.strokeStyle,
          "仅用于边界、异步或可选关系"
        );
      }
      if (element.opacity !== 100) {
        addViolation(element, "opacity", element.opacity, 100);
      }
    }

    if (isShape) {
      if (element.fillStyle !== shape.fillStyle) {
        addViolation(element, "fillStyle", element.fillStyle, shape.fillStyle);
      }
      if (element.type === "rectangle") {
        if (!hasOwn(element, "roundness")) {
          addViolation(
            element,
            "roundness",
            element.roundness,
            allowed.rectangleRoundnessTypes
          );
        } else {
          const roundnessType = element.roundness == null
            ? null
            : element.roundness?.type;
          if (!allowed.rectangleRoundnessTypes.includes(roundnessType)) {
            addViolation(
              element,
              "roundness",
              element.roundness,
              allowed.rectangleRoundnessTypes
            );
          } else if (roundnessType !== shape.roundness.type) {
            addWarning(
              element,
              "roundness",
              element.roundness,
              shape.roundness,
              "直角只用于表格或严格网格"
            );
          }
        }
      }
    }

    if (element.type === "text") {
      const defaultFamilies = [text.fontFamily, ...text.fontFamilyAliases];
      const codeFamilies = [text.codeFontFamily, ...text.codeFontFamilyAliases];
      if (defaultFamilies.includes(element.fontFamily)) {
        // Default system sans-serif text.
      } else if (codeFamilies.includes(element.fontFamily)) {
        addWarning(
          element,
          "fontFamily",
          element.fontFamily,
          text.fontFamily,
          "等宽字体只用于代码、路径或技术标识"
        );
      } else {
        addViolation(element, "fontFamily", element.fontFamily, defaultFamilies);
      }
      const usesAllowedTextSize = allowedTextSizes.includes(element.fontSize);
      if (!usesAllowedTextSize) {
        addViolation(element, "fontSize", element.fontSize, allowedTextSizes);
      }

      const boundContainer = element.containerId
        ? elementsById.get(element.containerId)
        : null;
      if (boundContainer) {
        if (usesAllowedTextSize && element.fontSize !== text.fontSize) {
          addViolation(element, "fontSize", element.fontSize, text.fontSize);
        }
        if (element.textAlign !== "center") {
          addViolation(element, "textAlign", element.textAlign, "center");
        }
        if (element.verticalAlign !== "middle") {
          addViolation(
            element,
            "verticalAlign",
            element.verticalAlign,
            "middle"
          );
        }
        const lineCount =
          typeof element.text === "string"
            ? element.text.replaceAll("\r\n", "\n").split("\n").length
            : 0;
        if (lineCount > 2) {
          addViolation(element, "lineCount", lineCount, "<= 2");
        }
      } else if (element.textAlign !== "left") {
        addViolation(element, "textAlign", element.textAlign, "left");
      }
    }

    if (element.type === "arrow") {
      if (!hasOwn(element, "roundness")) {
        addViolation(element, "roundness", element.roundness, arrow.roundness);
      }
      if (!hasOwn(element, "elbowed")) {
        addViolation(element, "elbowed", element.elbowed, arrow.elbowed);
      }
      if (!Array.isArray(element.points) || element.points.length < 2) {
        addViolation(element, "points", element.points, "at least two points");
      }
      for (const property of ["startArrowhead", "endArrowhead"]) {
        if (!allowed.arrowheads.includes(element[property])) {
          addViolation(element, property, element[property], allowed.arrowheads);
        }
      }
      if (element.startArrowhead === "triangle") {
        addWarning(
          element,
          "startArrowhead",
          element.startArrowhead,
          arrow.startArrowhead,
          "起点三角只用于明确的双向关系"
        );
      }
      if (element.endArrowhead === null) {
        addWarning(
          element,
          "endArrowhead",
          element.endArrowhead,
          arrow.endArrowhead,
          "无终点箭头只用于无方向关系"
        );
      }

      const route = classifyArrowRoute(element);
      if (!allowed.arrowRoutes.includes(route)) {
        addViolation(element, "route", route, allowed.arrowRoutes);
      } else if (route !== arrow.route) {
        addWarning(
          element,
          "route",
          route,
          arrow.route,
          route === "elbowed"
            ? "直角折线只用于跨区域或避障"
            : "曲线只用于无法通过布局解决的扇出"
        );
      }
    }
  }

  return {
    themeId: diagramTheme.id,
    checkedElements: scene.elements.length,
    violations,
    warnings
  };
}
