// Put maplibre's worker where the browser can actually fetch it.
//
// WHY THIS SCRIPT EXISTS, measured rather than assumed. maplibre-gl 6 asks for
// its worker at RUNTIME with `new URL('./maplibre-gl-worker.mjs',
// import.meta.url)`. No bundler detects that form statically, so webpack emits
// no asset for it — verified on this tree: after a clean `pnpm build`,
// `find .next -iname "*worker*"` returns nothing at all.
//
// WHAT THAT LOOKS LIKE WHEN IT BREAKS, and why it cost this project a day: the
// request does NOT 404. Next answers the app's own HTML with a 200, the worker
// starts, tries to execute HTML as JavaScript, and dies without a word. The map
// then reports `loaded=false`, `isStyleLoaded=false`, every layer and source
// registered, and ZERO features in any of them. Nothing in the console, no
// failed request, no CSP violation. Every honest explanation — the database,
// WebGL2, the load handler, legacy expressions, the CSP — was ruled out with
// evidence, and all of them were the wrong question.
//
// THE SHARED CHUNK COMES TOO, and forgetting it is the obvious way to get this
// wrong: the worker is 19 KB and imports ~514 KB of shared code by relative
// path. A `public/` directory with only the worker in it fails exactly like
// having no worker at all, one step later.
//
// NOT COMMITTED, generated. These are copies of files that live in
// node_modules; committing them creates a second source of truth that drifts
// silently on the next bump. `prebuild`/`predev` regenerate them and
// `scripts/check-maplibre-worker.ts` fails the gate if the wiring rots.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** The files the browser must be able to fetch, worker first. */
export const MAPLIBRE_WORKER_ASSETS = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"] as const;

/** Where they are served from. Same directory, because the import is relative. */
export const MAPLIBRE_PUBLIC_DIR = join("public", "maplibre");

/**
 * The specifier the worker uses to reach the shared chunk.
 *
 * Asserted at copy time rather than trusted: if a future version reaches for a
 * different path, or for a third file, copying these two would produce a worker
 * that still dies silently — the exact failure this script exists to end, back
 * again and just as quiet.
 */
export const SHARED_SPECIFIER = "./maplibre-gl-shared.mjs";

const RELATIVE_SPECIFIER = /from\s*["']((?:\.\.?\/)[^"']+)["']/g;

/**
 * Relative specifiers the copied files import that this script does not copy.
 *
 * The first version asserted the worker still imports the shared chunk. That
 * fires when the known file goes away and is blind to a new one arriving --
 * and a worker whose third import 404s dies exactly as silently as a worker
 * that is missing altogether.
 */
export function unknownRelativeImports(dist: string): string[] {
  const known = new Set<string>(MAPLIBRE_WORKER_ASSETS);
  const found = new Set<string>();
  for (const name of MAPLIBRE_WORKER_ASSETS) {
    const text = readFileSync(join(dist, name), "utf8");
    for (const m of text.matchAll(RELATIVE_SPECIFIER)) {
      const target = (m[1] ?? "").replace(/^\.\//, "");
      if (!known.has(target)) found.add(target);
    }
  }
  return [...found].sort();
}
export function maplibreDistDir(): string {
  return join(dirname(require.resolve("maplibre-gl/package.json")), "dist");
}

export function sha(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

export function maplibreVersion(): string {
  return (require("maplibre-gl/package.json") as { version: string }).version;
}

export function copyMaplibreWorker({ quiet = false }: { quiet?: boolean } = {}): {
  version: string;
  copied: string[];
} {
  const dist = maplibreDistDir();
  const version = maplibreVersion();

  const unexpected = unknownRelativeImports(dist);
  if (unexpected.length > 0) {
    throw new Error(
      `maplibre-gl ${version}: the copied files import relative modules that are not copied: ${unexpected.join(", ")}. Shipping without them produces a worker that cannot load, and it fails the way this whole script exists to prevent: silently, with a green build and an empty map. Add them to MAPLIBRE_WORKER_ASSETS.`,
    );
  }

  mkdirSync(MAPLIBRE_PUBLIC_DIR, { recursive: true });
  const copied: string[] = [];
  for (const name of MAPLIBRE_WORKER_ASSETS) {
    const from = join(dist, name);
    if (!existsSync(from)) {
      throw new Error(
        `maplibre-gl ${version}: dist/${name} is missing. Did the package layout change?`,
      );
    }
    copyFileSync(from, join(MAPLIBRE_PUBLIC_DIR, name));
    copied.push(`${name}@${sha(from)}`);
  }
  if (!quiet) {
    console.log(`maplibre worker -> ${MAPLIBRE_PUBLIC_DIR} (v${version}): ${copied.join(", ")}`);
  }
  return { version, copied };
}

const invokedDirectly =
  process.argv[1]?.replaceAll("\\", "/").endsWith("copy-maplibre-worker.ts") === true;

if (invokedDirectly) copyMaplibreWorker();
