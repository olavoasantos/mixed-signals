import { resolve } from "node:path";
import { build } from "tsdown";
import ts from "typescript";

/**
 * Cache of bundled entry scripts. Keyed by absolute path.
 * Each entry is bundled once per test run.
 */
const entryCache = new Map<string, Promise<string>>();

/**
 * Bundle a TypeScript entry file into a self-contained IIFE string
 * suitable for injection into a browser environment via route interception.
 *
 * Results are cached by absolute path — the same entry is only bundled once
 * per test run.
 */
export function bundleEntry(entryPath: string): Promise<string> {
  const absolute = resolve(entryPath);
  const cached = entryCache.get(absolute);
  if (cached) return cached;

  const promise = doBundleEntry(absolute);
  entryCache.set(absolute, promise);
  return promise;
}

async function doBundleEntry(absolute: string): Promise<string> {
  const result = await build({
    entry: { bundle: absolute },
    format: "iife",
    write: false,
    silent: true,
    platform: "browser",
    outDir: "dist", // required by tsdown but unused with write:false
  });

  const output = (result as any)[0];
  if (!output?.chunks?.length) {
    throw new Error(`bundleEntry: tsdown produced no output for ${absolute}`);
  }

  const chunk = output.chunks.find((c: any) => c.type === "chunk");
  if (!chunk?.code) {
    throw new Error(`bundleEntry: no chunk with code found for ${absolute}`);
  }

  return chunk.code;
}

/**
 * Transform a function or code string for use with evaluate().
 *
 * - Function: calls `.toString()`, strips TypeScript types.
 * - String without imports: strips TypeScript types.
 * - String with `import` statements: runs a full tsdown bundle.
 */
export async function transformForEvaluate(fnOrCode: Function | string): Promise<string> {
  const source = typeof fnOrCode === "function" ? fnOrCode.toString() : fnOrCode;

  // If the source contains import statements, it needs a full bundle
  if (typeof fnOrCode === "string" && hasImports(source)) {
    return bundleString(source);
  }

  // Otherwise, just strip types
  return stripTypes(source);
}

/**
 * Strip TypeScript types from a code string using TypeScript's transpileModule.
 */
function stripTypes(source: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      // Preserve the structure as much as possible
      removeComments: false,
      esModuleInterop: true,
    },
  });
  return result.outputText.trim().replace(/;$/, "");
}

/**
 * Check if a source string likely contains import statements.
 * Looks for `import` at the start of a line (possibly with leading whitespace).
 */
function hasImports(source: string): boolean {
  return /^\s*import\s/m.test(source);
}

/**
 * Bundle a code string through tsdown by writing to a temp file.
 * Used for evaluate() calls that contain import statements.
 */
async function bundleString(source: string): Promise<string> {
  const { writeFile, unlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const tmpPath = join(
    tmpdir(),
    `harness-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
  );

  try {
    await writeFile(tmpPath, source, "utf-8");
    return await doBundleEntry(tmpPath);
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * Clear the entry bundle cache. Call between test runs if needed.
 */
export function clearBundleCache(): void {
  entryCache.clear();
}
