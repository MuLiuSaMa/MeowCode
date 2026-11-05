#!/usr/bin/env node

import path from "node:path";

import {
  DEFAULT_THEME_MANIFEST,
  loadThemeManifest,
  resolveDiagramTheme,
  resolveUiTheme
} from "./theme-utils.mjs";

function parseArgs(argv) {
  const options = {};
  const valueFlags = new Set([
    "--ui-theme",
    "--diagram-theme",
    "--theme-manifest"
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list" || arg === "--help") {
      options[arg.slice(2)] = true;
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
  node scripts/show-theme.mjs --list
  node scripts/show-theme.mjs --ui-theme <id>
  node scripts/show-theme.mjs --diagram-theme <id>

Options:
  --theme-manifest <f>  Override the bundled theme manifest.
  --help                Show this help.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const manifestPath = path.resolve(
    options["theme-manifest"] || DEFAULT_THEME_MANIFEST
  );

  if (options.list) {
    const { manifest } = await loadThemeManifest(manifestPath);
    console.log(
      JSON.stringify(
        {
          defaultUiTheme: manifest.defaultUiTheme,
          defaultDiagramTheme: manifest.defaultDiagramTheme,
          uiThemes: Object.keys(manifest.uiThemes || {}),
          diagramThemes: Object.keys(manifest.diagramThemes || {})
        },
        null,
        2
      )
    );
    return;
  }

  if (!options["ui-theme"] && !options["diagram-theme"]) {
    printUsage();
    throw new Error("必须提供 --list、--ui-theme 或 --diagram-theme");
  }

  const output = {};
  if (options["ui-theme"]) {
    output.uiTheme = await resolveUiTheme(options["ui-theme"], manifestPath);
  }
  if (options["diagram-theme"]) {
    output.diagramTheme = await resolveDiagramTheme(
      options["diagram-theme"],
      manifestPath
    );
  }

  const value = output.uiTheme || output.diagramTheme;
  console.log(JSON.stringify(Object.keys(output).length === 1 ? value : output, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
