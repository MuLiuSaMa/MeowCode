#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_THEME_MANIFEST,
  resolveDiagramTheme,
  validateSceneColors
} from "./theme-utils.mjs";

function parseArgs(argv) {
  const options = {};
  const valueFlags = new Set([
    "--scene",
    "--diagram-theme",
    "--theme-manifest"
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--help") {
      options.help = true;
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

function printUsage() {
  console.log(`Usage:
  node scripts/validate-scene-theme.mjs --scene <file.excalidraw> [options]

Options:
  --diagram-theme <id>  Diagram Theme id. Defaults to the manifest default.
  --theme-manifest <f>  Override the bundled theme manifest.
  --strict              Exit with code 1 when off-token colors are found.
  --help                Show this help.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!options.scene) {
    printUsage();
    throw new Error("必须提供 --scene");
  }

  const scenePath = path.resolve(options.scene);
  const manifestPath = path.resolve(
    options["theme-manifest"] || DEFAULT_THEME_MANIFEST
  );
  const scene = JSON.parse(await readFile(scenePath, "utf8"));
  const diagramTheme = await resolveDiagramTheme(
    options["diagram-theme"],
    manifestPath
  );
  const result = validateSceneColors(scene, diagramTheme);

  console.log(JSON.stringify(result, null, 2));
  if (options.strict && result.violations.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
