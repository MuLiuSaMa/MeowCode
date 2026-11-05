#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_THEME_MANIFEST,
  diagramBoundTextColorsByBackground,
  resolveDiagramTheme,
  resolveUiTheme,
  validateSceneColors,
  validateSceneStyles
} from "./theme-utils.mjs";
import {
  createTemplateData,
  injectTemplateData
} from "./template-data.mjs";
import { normalizeExportedScene } from "./normalize-exported-scene.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE = path.resolve(
  SCRIPT_DIR,
  "../assets/canvas-editor-template.html"
);
function printUsage() {
  console.log(`Usage:
  node scripts/build-canvas-html.mjs --scene <file.excalidraw> --out <file.html> [options]

Options:
  --title <text>       Browser title. Defaults to the scene filename.
  --id <value>         Stable autosave id. Defaults to a hash of the scene path.
  --template <file>    Override the bundled HTML template.
  --ui-theme <id>      UI Theme id. Defaults to the manifest default.
  --diagram-theme <id> Diagram Theme id. Defaults to the manifest default.
  --theme-manifest <f> Override the bundled theme manifest.
  --strict-colors      Fail when the scene contains colors outside the Diagram Theme.
  --strict-style       Fail when the scene violates the Diagram Theme style profile.
  --help               Show this help.`);
}

function parseArgs(argv) {
  const options = {};
  const valueFlags = new Set([
    "--scene",
    "--out",
    "--title",
    "--id",
    "--template",
    "--ui-theme",
    "--diagram-theme",
    "--theme-manifest"
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg === "--strict-colors") {
      options.strictColors = true;
      continue;
    }

    if (arg === "--strict-style") {
      options.strictStyle = true;
      continue;
    }

    if (!valueFlags.has(arg)) {
      throw new Error(`未知参数：${arg}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} 缺少参数值`);
    }

    options[arg.slice(2)] = value;
    index += 1;
  }

  return options;
}

function validateScene(scene) {
  if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements)) {
    throw new Error("场景文件无效：缺少 elements 数组");
  }
}

function makeDocumentId(scenePath, explicitId) {
  if (explicitId) {
    const normalized = explicitId.replace(/[^a-zA-Z0-9._-]/g, "-");
    if (!/[a-zA-Z0-9]/.test(normalized)) {
      throw new Error("--id 必须至少包含一个字母或数字");
    }
    return normalized;
  }

  const digest = createHash("sha256")
    .update(path.resolve(scenePath))
    .digest("hex")
    .slice(0, 16);
  return `canvas-${digest}`;
}

function escapeHtmlText(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  if (!options.scene || !options.out) {
    printUsage();
    throw new Error("必须同时提供 --scene 和 --out");
  }

  const scenePath = path.resolve(options.scene);
  const outputPath = path.resolve(options.out);
  const templatePath = path.resolve(options.template || DEFAULT_TEMPLATE);
  const manifestPath = path.resolve(
    options["theme-manifest"] || DEFAULT_THEME_MANIFEST
  );

  const [sceneSource, templateSource, uiTheme, diagramTheme] = await Promise.all([
    readFile(scenePath, "utf8"),
    readFile(templatePath, "utf8"),
    resolveUiTheme(options["ui-theme"], manifestPath),
    resolveDiagramTheme(options["diagram-theme"], manifestPath)
  ]);
  const sourceScene = JSON.parse(sceneSource);
  validateScene(sourceScene);
  const labelColorsByBackground =
    diagramBoundTextColorsByBackground(diagramTheme);
  const scene = normalizeExportedScene(sourceScene, {
    labelColorsByBackground,
    defaultTextColor: diagramTheme.document?.text,
    documentBackground: diagramTheme.document?.background
  });
  const colorValidation = validateSceneColors(scene, diagramTheme);
  const styleValidation = diagramTheme.style
    ? validateSceneStyles(scene, diagramTheme)
    : null;

  if (options.strictColors && colorValidation.violations.length > 0) {
    const preview = colorValidation.violations
      .slice(0, 5)
      .map(
        ({ elementId, property, value }) =>
          `${elementId}.${property}=${value}`
      )
      .join(", ");
    throw new Error(
      `图表包含主题外颜色（${diagramTheme.id}）：${preview}`
    );
  }
  if (options.strictStyle && !styleValidation) {
    throw new Error(`Diagram Theme ${diagramTheme.id} 缺少 style 配置`);
  }
  if (options.strictStyle && styleValidation.violations.length > 0) {
    const preview = styleValidation.violations
      .slice(0, 5)
      .map(
        ({ elementId, property, value }) =>
          `${elementId}.${property}=${JSON.stringify(value)}`
      )
      .join(", ");
    throw new Error(
      `图表包含非默认样式（${diagramTheme.id}）：${preview}`
    );
  }

  const title = options.title || path.basename(scenePath, path.extname(scenePath));
  const documentId = makeDocumentId(scenePath, options.id);
  const templateData = createTemplateData({
    documentId,
    title,
    uiTheme,
    diagramTheme,
    scene
  });
  const withScene = injectTemplateData(templateSource, templateData);
  const html = withScene.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${escapeHtmlText(title)}</title>`
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html);

  console.log(
    JSON.stringify(
      {
        success: true,
        output: outputPath,
        template: templatePath,
        documentId,
        title,
        elements: scene.elements.length,
        uiTheme: uiTheme.id,
        diagramTheme: diagramTheme.id,
        colorWarnings: colorValidation.violations,
        styleViolations: styleValidation?.violations || [],
        styleWarnings: styleValidation?.warnings || [],
        bytes: Buffer.byteLength(html)
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
