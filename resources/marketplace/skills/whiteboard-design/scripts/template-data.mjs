import {
  diagramBoundTextColorsByBackground,
  uiThemeToCssVariables
} from "./theme-utils.mjs";
import { DEFAULT_INITIAL_VIEWPORT_POLICY } from "./initial-viewport-policy.mjs";
import { CANVAS_CAPABILITY_POLICY } from "./canvas-capabilities.mjs";

const TEMPLATE_DATA_PATTERN =
  /(<script id="excalidraw-template-data" type="application\/json">)[\s\S]*?(<\/script>)/;

function escapeJsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function editorFontFamily(textStyle) {
  const family = Number(textStyle.fontFamilyAliases?.[0]);
  if (!Number.isInteger(family)) {
    throw new Error("无法创建编辑器默认值：Diagram Theme 缺少数字字体别名");
  }
  return family;
}

function editorArrowType(route) {
  if (route === "elbowed") {
    return "elbow";
  }
  if (route === "curved") {
    return "round";
  }
  return "sharp";
}

export function createEditorDefaults(diagramTheme) {
  const shape = diagramTheme?.style?.shape;
  const text = diagramTheme?.style?.text;
  const arrow = diagramTheme?.style?.arrow;
  const neutralNode = diagramTheme?.node?.neutral;
  const document = diagramTheme?.document;

  if (!shape || !text || !arrow) {
    return null;
  }
  if (!neutralNode?.fill || !neutralNode.stroke || !document?.text || !document.connector) {
    throw new Error("无法创建编辑器默认值：Diagram Theme 缺少节点或文档颜色");
  }

  const fontFamily = editorFontFamily(text);
  const commonStroke = {
    currentItemStrokeWidth: shape.strokeWidth,
    currentItemStrokeStyle: shape.strokeStyle,
    currentItemRoughness: shape.roughness,
    currentItemOpacity: shape.opacity
  };
  const linearStroke = {
    currentItemBackgroundColor: "transparent",
    currentItemStrokeColor: document.connector,
    currentItemFillStyle: shape.fillStyle,
    currentItemStrokeWidth: arrow.strokeWidth,
    currentItemStrokeStyle: arrow.strokeStyle,
    currentItemRoughness: arrow.roughness,
    currentItemOpacity: arrow.opacity
  };
  const boundTextColorsByBackground =
    diagramBoundTextColorsByBackground(diagramTheme);

  return {
    version: 2,
    boundTextColorsByBackground,
    toolPresets: {
      rectangle: "shape",
      diamond: "shape",
      ellipse: "shape",
      arrow: "arrow",
      line: "line",
      text: "text",
      freedraw: "freedraw"
    },
    presets: {
      shape: {
        currentItemBackgroundColor: neutralNode.fill,
        currentItemStrokeColor: neutralNode.stroke,
        currentItemFillStyle: shape.fillStyle,
        ...commonStroke,
        currentItemRoundness: shape.roundness ? "round" : "sharp",
        currentItemFontFamily: fontFamily,
        currentItemFontSize: text.fontSize
      },
      arrow: {
        ...linearStroke,
        currentItemArrowType: editorArrowType(arrow.route),
        currentItemStartArrowhead: arrow.startArrowhead,
        currentItemEndArrowhead: arrow.endArrowhead
      },
      line: {
        ...linearStroke,
        currentItemRoundness: arrow.roundness ? "round" : "sharp",
        currentItemStartArrowhead: null,
        currentItemEndArrowhead: null
      },
      text: {
        currentItemBackgroundColor: "transparent",
        currentItemStrokeColor: document.text,
        currentItemFillStyle: shape.fillStyle,
        ...commonStroke,
        currentItemFontFamily: fontFamily,
        currentItemFontSize: text.fontSize,
        currentItemTextAlign: "left"
      },
      freedraw: {
        ...linearStroke
      }
    }
  };
}

export function createTemplateData({
  documentId,
  title,
  uiTheme,
  diagramTheme,
  scene
}) {
  if (!uiTheme?.id || !uiTheme.light) {
    throw new Error("无法创建模板数据：缺少已解析的 UI Theme");
  }
  if (!diagramTheme?.id) {
    throw new Error("无法创建模板数据：缺少已解析的 Diagram Theme");
  }

  const editorDefaults = createEditorDefaults(diagramTheme);
  // Preserve an explicit source background; only missing values inherit the
  // selected Diagram Theme so imported scenes are never silently recolored.
  const sceneWithDefaultBackground =
    scene &&
    (scene.appState?.viewBackgroundColor == null ||
      scene.appState.viewBackgroundColor === "")
      ? {
          ...scene,
          appState: {
            ...(scene.appState || {}),
            viewBackgroundColor: diagramTheme.document.background
          }
        }
      : scene;

  return {
    templateVersion: 5,
    documentId,
    title,
    capabilities: CANVAS_CAPABILITY_POLICY,
    uiTheme: {
      id: uiTheme.id,
      version: uiTheme.version,
      light: uiTheme.light,
      cssVariables: uiThemeToCssVariables(uiTheme)
    },
    diagramTheme: {
      id: diagramTheme.id,
      version: diagramTheme.version
    },
    initialViewport: { ...DEFAULT_INITIAL_VIEWPORT_POLICY },
    ...(editorDefaults ? { editorDefaults } : {}),
    scene: sceneWithDefaultBackground
  };
}

export function injectTemplateData(templateSource, templateData) {
  if (!TEMPLATE_DATA_PATTERN.test(templateSource)) {
    throw new Error("模板无效：缺少 excalidraw-template-data 数据槽");
  }

  const payload = escapeJsonForHtml(templateData);
  return templateSource.replace(
    TEMPLATE_DATA_PATTERN,
    (_match, openingTag, closingTag) => `${openingTag}${payload}${closingTag}`
  );
}
