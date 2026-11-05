#!/usr/bin/env node

import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  resolveDiagramTheme,
  resolveUiTheme
} from "./theme-utils.mjs";

const COLOR_PATTERN = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const SAFE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCAL_EVIDENCE_KINDS = new Set(["user-provided", "scene-derived"]);
const OUTPUT_FILES = [
  "primitives.json",
  "ui-theme.json",
  "diagram-theme.json",
  "manifest.json"
];
const LOCK_FILE = ".create-task-theme.lock";

function parseArgs(argv) {
  const options = {};
  const valueFlags = new Set(["--spec", "--out-dir"]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (!valueFlags.has(arg)) {
      throw new Error(`未知参数：${arg}`);
    }
    if (arg.slice(2) in options) {
      throw new Error(`参数不能重复：${arg}`);
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

function printUsage() {
  console.log(`Usage:
  node scripts/create-task-theme.mjs --spec <json> --out-dir <dir>

Required:
  --spec <json>   Task palette and evidence specification.
  --out-dir <dir> Directory for the self-contained theme bundle.

Options:
  --help          Show this help.`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeNonemptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

function normalizeColor(value, label) {
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
    throw new Error(`${label} 必须是 6 位或 8 位十六进制颜色，当前值：${value}`);
  }
  return value.toUpperCase();
}

function canonicalColorKey(color) {
  const normalized = color.toUpperCase();
  return normalized.length === 9 && normalized.endsWith("FF")
    ? normalized.slice(0, 7)
    : normalized;
}

function normalizeOpaqueColor(value, label) {
  const color = normalizeColor(value, label);
  if (color.length === 9 && !color.endsWith("FF")) {
    throw new Error(`${label} 必须是不透明颜色（6 位或以 FF 结尾的 8 位颜色）`);
  }
  return canonicalColorKey(color);
}

function normalizeColorTree(value, label) {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeColorTree(entry, `${label}.${index + 1}`)
    );
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeColorTree(entry, `${label}.${key}`)
      ])
    );
  }
  return normalizeColor(value, label);
}

function normalizeOptionalOpaqueColor(value, label) {
  return value === undefined ? undefined : normalizeOpaqueColor(value, label);
}

function validateDate(value, label) {
  const date = normalizeNonemptyString(value, label);
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`${label} 必须使用 YYYY-MM-DD 格式`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysPerMonth[month - 1]) {
    throw new Error(`${label} 不是有效日期：${date}`);
  }
  return date;
}

function normalizeHttpUrl(value, label) {
  const urlValue = normalizeNonemptyString(value, label);
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error(`${label} 必须是有效的 http(s) URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new Error(`${label} 必须是有效的 http(s) URL`);
  }
  return urlValue;
}

function normalizeSource(source, index) {
  const label = `brand.sources[${index}]`;
  if (!isRecord(source)) {
    throw new Error(`${label} 必须是证据对象`);
  }

  const kind = normalizeNonemptyString(source.kind, `${label}.kind`);
  const output = { ...source, kind };
  let url;
  let reference;
  let note;

  if (source.url !== undefined) {
    url = normalizeHttpUrl(source.url, `${label}.url`);
    output.url = url;
  }
  if (source.reference !== undefined) {
    reference = normalizeNonemptyString(source.reference, `${label}.reference`);
    output.reference = reference;
  }
  if (source.note !== undefined) {
    note = normalizeNonemptyString(source.note, `${label}.note`);
    output.note = note;
  }

  if (LOCAL_EVIDENCE_KINDS.has(kind.toLowerCase())) {
    if (!url && !reference && !note) {
      throw new Error(
        `${label}（${kind}）必须包含有效 URL、reference 或 note 作为来源证据`
      );
    }
  } else if (!url) {
    throw new Error(`${label}（${kind}）必须包含有效的 http(s) 来源 URL`);
  }

  return output;
}

function normalizeBrand(value) {
  if (!isRecord(value)) {
    throw new Error("brand 必须是对象");
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw new Error("brand.sources 至少需要一条来源证据");
  }

  return {
    ...value,
    name: normalizeNonemptyString(value.name, "brand.name"),
    checkedAt: validateDate(value.checkedAt, "brand.checkedAt"),
    sources: value.sources.map(normalizeSource)
  };
}

function normalizeUniqueColorArray(value, label, { min, max }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} 必须包含 ${min}–${max} 个颜色`);
  }
  const colors = value.map((entry, index) =>
    normalizeOpaqueColor(entry, `${label}[${index}]`)
  );
  if (new Set(colors).size !== colors.length) {
    throw new Error(`${label} 中的颜色必须唯一`);
  }
  return colors;
}

function normalizeRole(value, label, fallback) {
  if (value === undefined) {
    return clone(fallback);
  }
  if (typeof value === "string") {
    return { ...clone(fallback), fill: normalizeOpaqueColor(value, label) };
  }
  if (!isRecord(value)) {
    throw new Error(`${label} 必须是颜色或包含 fill、stroke、text 的对象`);
  }

  const allowedKeys = new Set(["fill", "stroke", "text"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${label} 包含未知颜色角色：${key}`);
    }
  }

  const role = clone(fallback);
  for (const key of allowedKeys) {
    if (value[key] !== undefined) {
      role[key] = key === "stroke"
        ? normalizeColor(value[key], `${label}.${key}`)
        : normalizeOpaqueColor(value[key], `${label}.${key}`);
    }
  }
  return role;
}

function normalizePalette(value) {
  if (!isRecord(value)) {
    throw new Error("palette 必须是对象");
  }

  const allowedKeys = new Set([
    "primary",
    "series",
    "other",
    "accents",
    "semantic",
    "background",
    "text",
    "mutedText",
    "connector",
    "onPrimary",
    "emphasisFill",
    "emphasisText",
    "neutral",
    "secondary"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`palette 包含未知字段：${key}`);
    }
  }

  const primary = normalizeOpaqueColor(value.primary, "palette.primary");
  const series = normalizeUniqueColorArray(value.series, "palette.series", {
    min: 1,
    max: 4
  });
  let accents;
  if (value.accents !== undefined) {
    accents = normalizeUniqueColorArray(value.accents, "palette.accents", {
      min: 0,
      max: 2
    });
  }

  const other = normalizeOptionalOpaqueColor(value.other, "palette.other");
  if (other !== undefined && series.includes(other)) {
    throw new Error("palette.other 不能与 palette.series 中的颜色重复");
  }
  if (accents !== undefined) {
    const reservedDataColors = new Set([
      ...series,
      ...(other === undefined ? [] : [other])
    ]);
    const repeatedAccent = accents.find((color) => reservedDataColors.has(color));
    if (repeatedAccent) {
      throw new Error(
        `palette.accents 不能与 palette.series 或 palette.other 重复：${repeatedAccent}`
      );
    }
  }

  let semantic = {};
  if (value.semantic !== undefined) {
    if (!isRecord(value.semantic)) {
      throw new Error("palette.semantic 必须是颜色对象树");
    }
    semantic = normalizeColorTree(value.semantic, "palette.semantic");
  }

  return {
    primary,
    series,
    other,
    accents,
    semantic,
    background: normalizeOptionalOpaqueColor(
      value.background,
      "palette.background"
    ),
    text: normalizeOptionalOpaqueColor(value.text, "palette.text"),
    mutedText: normalizeOptionalOpaqueColor(
      value.mutedText,
      "palette.mutedText"
    ),
    connector: normalizeOptionalOpaqueColor(
      value.connector,
      "palette.connector"
    ),
    onPrimary: normalizeOptionalOpaqueColor(
      value.onPrimary,
      "palette.onPrimary"
    ),
    emphasisFill: normalizeOptionalOpaqueColor(
      value.emphasisFill,
      "palette.emphasisFill"
    ),
    emphasisText: normalizeOptionalOpaqueColor(
      value.emphasisText,
      "palette.emphasisText"
    ),
    neutral: value.neutral,
    secondary: value.secondary
  };
}

function parseColor(color) {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const alpha = color.length === 9
    ? Number.parseInt(color.slice(7, 9), 16) / 255
    : 1;
  return { red, green, blue, alpha };
}

function compositeColor(foreground, background) {
  return {
    red: Math.round(foreground.red * foreground.alpha + background.red * (1 - foreground.alpha)),
    green: Math.round(foreground.green * foreground.alpha + background.green * (1 - foreground.alpha)),
    blue: Math.round(foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha)),
    alpha: 1
  };
}

function opaqueColor(color, background = { red: 255, green: 255, blue: 255, alpha: 1 }) {
  return compositeColor(parseColor(color), background);
}

function toHex({ red, green, blue }) {
  const channel = (value) => Math.max(0, Math.min(255, value))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function blendPrimaryOverBackground(primary, background, weight = 0.12) {
  const backgroundColor = opaqueColor(background);
  const foreground = parseColor(primary);
  const effectiveWeight = weight * foreground.alpha;
  return toHex({
    red: Math.round(foreground.red * effectiveWeight + backgroundColor.red * (1 - effectiveWeight)),
    green: Math.round(foreground.green * effectiveWeight + backgroundColor.green * (1 - effectiveWeight)),
    blue: Math.round(foreground.blue * effectiveWeight + backgroundColor.blue * (1 - effectiveWeight))
  });
}

function relativeLuminance(color) {
  const linearize = (channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(color.red)
    + 0.7152 * linearize(color.green)
    + 0.0722 * linearize(color.blue);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function textContrast(text, fill, background) {
  const backgroundColor = opaqueColor(background);
  const fillColor = compositeColor(parseColor(fill), backgroundColor);
  const textColor = compositeColor(parseColor(text), fillColor);
  return contrastRatio(textColor, fillColor);
}

function chooseTextColor(fill, background, darkText) {
  const candidates = ["#FFFFFF", darkText];
  return candidates.reduce((best, candidate) =>
    textContrast(candidate, fill, background)
      > textContrast(best, fill, background)
      ? candidate
      : best
  );
}

function assertTextContrast(text, fill, background, label) {
  const ratio = textContrast(text, fill, background);
  if (ratio < 4.5) {
    throw new Error(
      `${label} 与底色的对比度必须至少为 4.5:1，当前为 ${ratio.toFixed(2)}:1`
    );
  }
}

function assertNodeRoleFillCompatibility(node) {
  const rolesByFill = new Map();
  for (const [roleName, role] of Object.entries(node)) {
    const fillKey = canonicalColorKey(role.fill);
    const existing = rolesByFill.get(fillKey);
    if (!existing) {
      rolesByFill.set(fillKey, { roleName, role });
      continue;
    }

    const hasSameMapping =
      canonicalColorKey(existing.role.stroke) === canonicalColorKey(role.stroke)
      && canonicalColorKey(existing.role.text) === canonicalColorKey(role.text);
    if (!hasSameMapping) {
      throw new Error(
        `节点角色 fill ${role.fill} 冲突：node.${existing.roleName} 与 node.${roleName} `
        + "使用相同 fill，但 stroke 或 text 不一致"
      );
    }
  }
}

function collectColorLeaves(value, colors = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectColorLeaves(entry, colors));
    return colors;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((entry) => collectColorLeaves(entry, colors));
    return colors;
  }
  colors.push(value);
  return colors;
}

function buildDataLabelRoles({
  palette,
  node,
  background,
  darkText,
  derivations
}) {
  const nodeFills = new Set(
    Object.values(node).map((role) => canonicalColorKey(role.fill))
  );
  const candidates = [
    ...palette.series,
    ...(palette.other === undefined ? [] : [palette.other]),
    ...(palette.accents ?? []),
    ...collectColorLeaves(palette.semantic)
  ];
  const seen = new Set();
  const labelRoles = [];

  for (const fill of candidates) {
    const fillKey = canonicalColorKey(fill);
    if (seen.has(fillKey) || nodeFills.has(fillKey)) {
      continue;
    }
    seen.add(fillKey);

    const text = chooseTextColor(fill, background, darkText);
    const index = labelRoles.length;
    labelRoles.push({ fill, text });
    derivations.push({
      role: `data.labelRoles[${index}].text`,
      method: "wcag-contrast-choice",
      fill,
      basis: `Compared #FFFFFF and ${darkText} on ${fill}; chose ${text}.`
    });
  }

  return labelRoles;
}

function buildDiagramTheme(spec, defaultTheme) {
  const { id, brand, palette } = spec;
  const background = palette.background ?? defaultTheme.document.background;
  const text = palette.text ?? defaultTheme.document.text;
  const mutedText = palette.mutedText ?? defaultTheme.document.mutedText;
  const connector = palette.connector ?? defaultTheme.document.connector;
  const emphasisFill = palette.emphasisFill
    ?? blendPrimaryOverBackground(palette.primary, background);
  const darkText = defaultTheme.document.text;
  const onPrimary = palette.onPrimary
    ?? chooseTextColor(palette.primary, background, darkText);
  const emphasisText = palette.emphasisText
    ?? chooseTextColor(emphasisFill, background, darkText);
  const derivations = [];

  if (palette.onPrimary === undefined) {
    derivations.push({
      role: "node.primary.text",
      method: "wcag-contrast-choice",
      basis: `Compared #FFFFFF and ${darkText} on ${palette.primary}; chose ${onPrimary}.`
    });
  }
  if (palette.emphasisFill === undefined) {
    derivations.push({
      role: "node.emphasis.fill",
      method: "primary-overlay",
      basis: `Blended ${palette.primary} at 12% over ${background}; derived ${emphasisFill}.`
    });
  }
  if (palette.emphasisText === undefined) {
    derivations.push({
      role: "node.emphasis.text",
      method: "wcag-contrast-choice",
      basis: `Compared #FFFFFF and ${darkText} on ${emphasisFill}; chose ${emphasisText}.`
    });
  }

  if (palette.onPrimary !== undefined) {
    assertTextContrast(onPrimary, palette.primary, background, "palette.onPrimary");
  }
  if (palette.emphasisText !== undefined) {
    assertTextContrast(
      emphasisText,
      emphasisFill,
      background,
      "palette.emphasisText"
    );
  }

  const neutralFallback = { ...defaultTheme.node.neutral, text };
  const secondaryFallback = { ...defaultTheme.node.secondary, text };
  const neutral = normalizeRole(
    palette.neutral,
    "palette.neutral",
    neutralFallback
  );
  const secondary = normalizeRole(
    palette.secondary,
    "palette.secondary",
    secondaryFallback
  );
  const node = {
    neutral,
    primary: {
      fill: palette.primary,
      stroke: palette.primary,
      text: onPrimary
    },
    emphasis: {
      fill: emphasisFill,
      stroke: palette.primary,
      text: emphasisText
    },
    secondary
  };

  assertTextContrast(text, background, "#FFFFFF", "document.text");
  assertTextContrast(mutedText, background, "#FFFFFF", "document.mutedText");
  assertTextContrast(neutral.text, neutral.fill, background, "node.neutral.text");
  assertTextContrast(
    secondary.text,
    secondary.fill,
    background,
    "node.secondary.text"
  );
  assertNodeRoleFillCompatibility(node);

  const data = { accents: palette.accents ?? [] };
  if (palette.other !== undefined) {
    data.other = palette.other;
  }
  data.labelRoles = buildDataLabelRoles({
    palette,
    node,
    background,
    darkText,
    derivations
  });

  return {
    id,
    version: 1,
    tags: ["task", "evidence-backed"],
    brandEvidence: { ...brand, derivations },
    document: {
      background,
      text,
      mutedText,
      connector,
      primaryConnector: palette.primary
    },
    node,
    style: clone(defaultTheme.style),
    data,
    semantic: palette.semantic,
    series: palette.series
  };
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readSpec(specPath) {
  let source;
  try {
    source = await readFile(specPath, "utf8");
  } catch (error) {
    throw new Error(`无法读取主题规格：${specPath}（${error.message}）`);
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`主题规格不是有效 JSON：${specPath}（${error.message}）`);
  }
  if (!isRecord(value)) {
    throw new Error("主题规格必须是 JSON 对象");
  }

  const id = normalizeNonemptyString(value.id, "id");
  if (!SAFE_SLUG_PATTERN.test(id)) {
    throw new Error("id 必须是安全的小写 slug（仅可使用字母、数字和单个连字符）");
  }

  return {
    id,
    brand: normalizeBrand(value.brand),
    palette: normalizePalette(value.palette)
  };
}

function buildBundle(uiTheme, diagramTheme) {
  const manifest = {
    version: 1,
    primitives: "./primitives.json",
    defaultUiTheme: uiTheme.id,
    defaultDiagramTheme: diagramTheme.id,
    uiThemes: {
      [uiTheme.id]: "./ui-theme.json"
    },
    diagramThemes: {
      [diagramTheme.id]: "./diagram-theme.json"
    }
  };

  return {
    "primitives.json": serializeJson({}),
    "ui-theme.json": serializeJson(uiTheme),
    "diagram-theme.json": serializeJson(diagramTheme),
    "manifest.json": serializeJson(manifest)
  };
}

async function validateBundle(directory, uiThemeId, diagramThemeId) {
  const manifestPath = path.join(directory, "manifest.json");
  return Promise.all([
    resolveUiTheme(uiThemeId, manifestPath),
    resolveDiagramTheme(diagramThemeId, manifestPath)
  ]);
}

async function validateStagedBundle(bundle, uiThemeId, diagramThemeId) {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "canvas-task-theme-validation-")
  );
  try {
    await Promise.all(
      OUTPUT_FILES.map((filename) =>
        writeFile(path.join(temporaryDirectory, filename), bundle[filename], "utf8")
      )
    );
    await validateBundle(temporaryDirectory, uiThemeId, diagramThemeId);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function atomicWrite(targetPath, contents) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.create-task-theme-${path.basename(targetPath)}-${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        error.message += `；临时文件清理失败：${cleanupError.message}`;
      }
    }
    throw error;
  }
}

async function writeBundle(
  outputDirectory,
  bundle,
  uiThemeId,
  diagramThemeId
) {
  await mkdir(outputDirectory, { recursive: true });
  const lockPath = path.join(outputDirectory, LOCK_FILE);
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`输出目录正在被另一个主题生成任务使用：${outputDirectory}`);
    }
    throw error;
  }

  const changed = [];
  const unchanged = [];
  try {
    const entries = await readdir(outputDirectory);
    const unexpected = entries.filter(
      (entry) => entry !== LOCK_FILE && !OUTPUT_FILES.includes(entry)
    );
    if (unexpected.length > 0) {
      throw new Error(
        `输出目录包含非主题文件，拒绝覆盖：${unexpected.join(", ")}`
      );
    }

    for (const filename of OUTPUT_FILES) {
      const targetPath = path.join(outputDirectory, filename);
      let current;
      try {
        current = await readFile(targetPath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw new Error(`无法检查现有输出 ${targetPath}：${error.message}`);
        }
      }

      if (current === bundle[filename]) {
        unchanged.push(filename);
        continue;
      }
      await atomicWrite(targetPath, bundle[filename]);
      changed.push(filename);
    }

    const [resolvedUiTheme, resolvedDiagramTheme] = await validateBundle(
      outputDirectory,
      uiThemeId,
      diagramThemeId
    );
    return { changed, unchanged, resolvedUiTheme, resolvedDiagramTheme };
  } finally {
    try {
      await lock.close();
    } finally {
      await unlink(lockPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!options.spec || !options["out-dir"]) {
    printUsage();
    throw new Error("必须同时提供 --spec 和 --out-dir");
  }

  const specPath = path.resolve(options.spec);
  const outputDirectory = path.resolve(options["out-dir"]);
  const spec = await readSpec(specPath);
  const [defaultDiagramTheme, defaultUiTheme] = await Promise.all([
    resolveDiagramTheme("brand-default"),
    resolveUiTheme()
  ]);
  const diagramTheme = buildDiagramTheme(spec, defaultDiagramTheme);
  const bundle = buildBundle(defaultUiTheme, diagramTheme);

  await validateStagedBundle(bundle, defaultUiTheme.id, diagramTheme.id);
  const writeResult = await writeBundle(
    outputDirectory,
    bundle,
    defaultUiTheme.id,
    diagramTheme.id
  );
  const { resolvedUiTheme, resolvedDiagramTheme } = writeResult;

  console.log(
    JSON.stringify(
      {
        ok: true,
        id: resolvedDiagramTheme.id,
        uiTheme: resolvedUiTheme.id,
        manifest: path.join(outputDirectory, "manifest.json"),
        changed: writeResult.changed,
        unchanged: writeResult.unchanged
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`create-task-theme: ${error.message}`);
  process.exitCode = 1;
});
