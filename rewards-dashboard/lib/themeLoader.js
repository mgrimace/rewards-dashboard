"use strict";

const fs = require("node:fs");
const path = require("node:path");

const THEMES_DIR = path.join(__dirname, "..", "public", "themes");

/**
 * Finds theme palette files by naming convention (anything ending in
 * `Theme.ts`, matching the convention used by the source files themselves:
 * defaultTheme.ts, catppuccinTheme.ts, draculaTheme.ts, ...). `types.ts` and
 * anything named `index.ts` are ignored - the registry below replaces the
 * need for a hand-maintained index file entirely.
 */
function listThemeFiles() {
  let entries;
  try {
    entries = fs.readdirSync(THEMES_DIR);
  } catch {
    return [];
  }
  const files = entries.filter((f) => /Theme\.ts$/.test(f) && f !== "types.ts");

  // Stable, predictable ordering: defaultTheme first, then alphabetical -
  // matches the ordering convention of the source project's own index.ts.
  files.sort((a, b) => {
    const aDefault = /^default/i.test(a);
    const bDefault = /^default/i.test(b);
    if (aDefault && !bDefault) return -1;
    if (bDefault && !aDefault) return 1;
    return a.localeCompare(b);
  });
  return files;
}

/**
 * Pulls the exported const identifier out of a theme file, e.g.
 * `export const catppuccinTheme: ThemeDefinition = {` -> "catppuccinTheme".
 * Falls back to deriving a name from the filename if the file is oddly
 * formatted, so a slightly different export style still gets picked up.
 */
function extractExportName(source, filename) {
  const m = /export\s+const\s+(\w+)\s*[:=]/.exec(source);
  if (m) return m[1];
  return filename.replace(/\.ts$/, "");
}

/**
 * Synthesizes the ES module that `themes/index.js` serves: imports every
 * discovered theme file and exports a `themes` array, mirroring the shape
 * of a hand-written registry - just generated fresh on every request so new
 * files show up with no restart and no manual edits.
 */
function generateIndexModule() {
  const files = listThemeFiles();
  if (!files.length) {
    return `// No theme files found in public/themes/ (looking for *Theme.ts)\nexport const themes = []\n`;
  }

  const imports = [];
  const names = [];
  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(path.join(THEMES_DIR, file), "utf8");
    } catch {
      continue;
    }
    const exportName = extractExportName(source, file);
    imports.push(`import { ${exportName} } from './${file}'`);
    names.push(exportName);
  }

  return `${imports.join("\n")}\n\nexport const themes = [${names.join(", ")}]\n`;
}

module.exports = { listThemeFiles, generateIndexModule, THEMES_DIR };
