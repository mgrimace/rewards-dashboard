"use strict";

/**
 * A tiny, purpose-built TypeScript -> JS transform for theme palette files
 * ONLY. This is not a general TS compiler - it strips just the handful of
 * constructs these files use (plain `export const X: ThemeDefinition = {...}`
 * data literals with a couple of type-only imports), so theme files copied
 * in from another project can be dropped in completely unmodified and still
 * run as native browser ES modules with zero build step.
 *
 * Handles:
 *   - `import type { ... } from '...'` lines -> removed entirely
 *   - `export interface X { ... }` blocks -> removed entirely (brace-aware,
 *     so nested object-type literals like `palettes: { light: X; dark: X }`
 *     don't break a naive single-brace regex)
 *   - `export type X = ...` lines -> removed entirely
 *   - `: TypeName` annotation on `export const NAME: TypeName = ...` -> stripped
 *   - extensionless relative import specifiers -> `.ts` appended, so the
 *     browser's native ES module resolution can find the sibling file
 *     (this server transpiles any `.ts` under /themes/ on the fly)
 */

function stripBraceBlocks(source, startRe) {
  let out = "";
  let lastIndex = 0;
  const re = new RegExp(startRe.source, "g");
  let match;
  while ((match = re.exec(source))) {
    const start = match.index;
    const braceStart = source.indexOf("{", start);
    if (braceStart === -1) break;
    out += source.slice(lastIndex, start);
    let depth = 0;
    let j = braceStart;
    for (; j < source.length; j++) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    lastIndex = j;
    re.lastIndex = j;
  }
  out += source.slice(lastIndex);
  return out;
}

function transformThemeModule(source) {
  let out = source;

  // Type-only imports: nothing at runtime needs these.
  out = out.replace(
    /^[ \t]*import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm,
    "",
  );

  // `export interface X { ... }` blocks (brace-aware for nested types).
  out = stripBraceBlocks(out, /export\s+interface\s+\w+\s*/g);

  // `export type X = ...` lines.
  out = out.replace(/^[ \t]*export\s+type\s+\w+\s*=.*$/gm, "");

  // `: TypeName` annotation on an exported const declaration.
  out = out.replace(/(export\s+const\s+\w+)\s*:\s*[\w.<>[\]]+(\s*=)/g, "$1$2");

  // Extensionless relative specifiers -> add .ts so native ESM resolves.
  out = out.replace(/from\s+(['"])(\.[^'"]+)\1/g, (full, quote, spec) => {
    if (/\.[a-zA-Z0-9]+$/.test(spec)) return full;
    return `from ${quote}${spec}.ts${quote}`;
  });

  return out;
}

module.exports = { transformThemeModule };
