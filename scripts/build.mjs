#!/usr/bin/env node
/**
 * Runs `next build` under a heap ceiling derived from the memory this machine
 * actually has, instead of a constant baked into package.json.
 *
 * Why this file exists: the ceiling used to be a literal
 * `--max-old-space-size=8192`, added to stop the compiler dying on a 32 GB
 * workstation. On Vercel's build container (2 cores, 8 GB) that same number is
 * fatal — it tells V8 it may grow to 8 GB of heap alone inside a container that
 * has roughly that much in total, so V8 never self-limits and the OOM killer
 * takes the worker down with SIGKILL. A ceiling is only meaningful relative to
 * the box it runs on, so it has to be computed on the box.
 *
 * Two quantities decide it, and missing either one produced a wrong answer on
 * the way here: how much memory the cgroup actually allows, and how many
 * processes will each claim a ceiling of that size. The second is the one that
 * is easy to forget — NODE_OPTIONS is inherited, and `next build` forks a
 * worker per core.
 *
 * The cap keeps 8192 as the maximum, and on the workstation the computed value
 * lands far above it, so the local ceiling is exactly what it is today and the
 * original fix cannot regress. Only memory-constrained boxes change.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, totalmem } from "node:os";

/**
 * The most a single process may be told it can use.
 *
 * On a box with room, that means 8192 — what package.json used to hardcode, so
 * the workstation's ceiling is exactly what it is today and the fix that
 * introduced it (ca9956a5) cannot regress. Measured 2026-08-20: this repo's
 * `next build` completes with a ceiling of 2867 MB, so on a large box anything
 * above ~3 GB is pure headroom and costs nothing.
 *
 * On a box without room the ceiling is not dropped to zero either, and that is
 * the correction to an earlier version of this file. Leaving NODE_OPTIONS unset
 * looks like deferring to Node, but NODE_OPTIONS is INHERITED BY EVERY CHILD,
 * and `next build` forks one worker per available core. Node then sizes each
 * worker's heap independently from the same cgroup limit, so two workers each
 * grow toward a budget that only exists once and the container's OOM killer
 * takes the build. Observed exactly that on Vercel 2026-08-20: with the type
 * pass already skipped, compilation still died with SIGKILL after 8 minutes.
 *
 * So a constrained box gets the budget DIVIDED BY the number of workers that
 * will share it. That is a bound, not a guess: whatever the parallelism, total
 * heap across the fleet stays inside `limit - RESERVED_MB`.
 */
const CEILING_MB = 8192;

/**
 * Below this a heap ceiling stops protecting anything and just guarantees a
 * different death. If the division lands here, the box is too small to build
 * this app and the log should say so rather than pretend a number will help.
 */
const MIN_WORKER_HEAP_MB = 1024;

/**
 * What the heaviest worker in THIS repo's build actually needs, measured.
 *
 * The floor above answers "is a ceiling still meaningful?". This one answers a
 * different question the earlier version never asked: "is the share big enough
 * for the work?" On 2026-08-22 the deploy died with the share set to 3584 MB
 * and V8's own error, not the container's —
 *   Mark-Compact 3558.4 (3587.4) -> 3558.4 (3587.4) MB … allocation failure
 *   FATAL ERROR: Ineffective mark-compacts near heap limit … SIGABRT
 * — a worker that reached its ceiling and aborted. So the divisor cannot be
 * pushed arbitrarily high to make the arithmetic fit: past a point, more
 * workers means every one of them is too small to finish.
 *
 * 4096 is the measured 3584 rounded up to the next power of two. It is a
 * FLOOR, not a target: a box with room gives its single worker far more.
 */
const MIN_VIABLE_WORKER_HEAP_MB = 4096;

/**
 * V8's old space is not the whole process: native allocations, source maps,
 * the pnpm parent and the OS all live outside it. That overhead is roughly a
 * constant, not a proportion of the box, so it is reserved as an absolute
 * rather than as a percentage — a percentage starves a small container while
 * wasting headroom on a large one.
 *
 * It also has to cover whatever the host agent runs inside the same cgroup. On
 * Vercel that is not nothing: a build that fits an 8192 MB container in a local
 * Docker container of the same declared size still died there.
 *
 * History of the values tried against the deploy target (2 cores, 8192 MB),
 * kept because every one of them was a plausible answer that turned out wrong:
 *   8192, single process   -> container OOM-kills the build.
 *   7168 and 5734, single  -> no OOM; ground to a halt until the 45-minute
 *                             build timeout. Read at the time as GC thrash on
 *                             two cores. It was not — it was the tsc pass that
 *                             `next build` runs after compiling, dying slowly
 *                             instead of quickly. See next.config.ts.
 *   no flag at all         -> type pass now skipped, and compilation ITSELF
 *                             SIGKILLed after 8 minutes: every forked worker
 *                             sized its own heap from the same cgroup limit.
 *   headroom / workers     -> what this file computes now.
 *   reserve 1024           -> held for three days of deploys, then two in a row
 *                             SIGKILLed ~80s into compilation (2026-08-25) with
 *                             the ceiling working exactly as designed: 1 worker,
 *                             7168 MB heap. The heap was never the overrun — a
 *                             7168 ceiling in an 8192 box leaves ~1 GB for the
 *                             worker's non-heap RSS, the parent next process,
 *                             pnpm and the host agent COMBINED, and the module
 *                             graph outgrew that sliver. The reserve is what was
 *                             wrong, not the division.
 */
const RESERVED_MB = 2048;

/**
 * `os.totalmem()` reports the HOST's memory from inside a container, which is
 * precisely the number that must not be trusted here. cgroup is the only
 * source that knows the limit the OOM killer will actually enforce.
 */
function detectLimitMb() {
  const cgroupFiles = [
    "/sys/fs/cgroup/memory.max", // cgroup v2
    "/sys/fs/cgroup/memory/memory.limit_in_bytes", // cgroup v1
  ];

  for (const file of cgroupFiles) {
    let raw;
    try {
      raw = readFileSync(file, "utf8").trim();
    } catch {
      continue; // absent on Windows and outside containers
    }
    if (raw === "max") continue; // v2 spelling for "no limit"
    const bytes = Number(raw);
    // v1 spells "no limit" as a sentinel near 2^63, which is not a limit.
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > Number.MAX_SAFE_INTEGER) continue;
    const mb = Math.floor(bytes / 1024 / 1024);
    if (mb >= 512 && mb < totalmem() / 1024 / 1024) {
      return { mb, source: file };
    }
  }

  return { mb: Math.floor(totalmem() / 1024 / 1024), source: "os.totalmem()" };
}

const rawOverride = process.env.BUILD_HEAP_MB ?? "";
const override = Number(rawOverride);

// One predicate, used by both the value and the message below. They used to be
// two — `Number.isFinite(override) && override > 0` for the value and a bare
// `override > 0` for the log — and they disagreed for anything positive but not
// finite ("Infinity", "1e999"): the value was discarded while the log still
// announced an override. A line whose entire job is to be believed when a build
// dies must not describe a state the script is not in.
//
// Integers only. V8 parses --max-old-space-size as size_t and rejects "6.5"
// outright, so a fractional value would turn this emergency lever into an
// instant `bad option` exit. Truncating instead would be worse: BUILD_HEAP_MB=6.5
// would silently become a 6 MB ceiling and die mid-build as a fake OOM.
const hasOverride = Number.isInteger(override) && override > 0;

// A value that was supplied and then dropped is the one case that must never be
// silent: "8G", "8192mb" and "8_192" all parse to NaN, and the operator would
// otherwise watch the build ignore their lever with no explanation.
if (rawOverride !== "" && !hasOverride) {
  console.warn(
    `[build] ignoring BUILD_HEAP_MB=${JSON.stringify(rawOverride)} — expected a positive integer number of megabytes (e.g. 6144), not a size suffix`,
  );
}

const detected = detectLimitMb();
const headroom = detected.mb - RESERVED_MB;

// THE DIVISOR WAS NEVER THE FLEET (corrected 2026-08-23).
//
// This block used to read `workers = availableParallelism()` and call the
// result "a bound, not a guess". It was a guess, and it was wrong by an order
// of magnitude. `next build` does not fork a worker per available core: it
// calls its own getNumberOfWorkers(), which returns `experimental.cpus`, whose
// DEFAULT is `Math.max(1, os.cpus().length - 1)`
// (node_modules/next/dist/server/config-shared.js). That is the same
// `os.cpus()` the comment below already knew not to trust — it reports the
// HOST's cores from inside the container. So on a 2-core Vercel box the script
// computed a share for 2 workers while Next stood ready to fork ~15, each
// inheriting the same NODE_OPTIONS ceiling. Total heap the fleet could claim
// was several times the container.
//
// A budget divided among a fleet you do not control is not a bound. So the
// script now DECIDES the fleet and tells Next what it decided
// (DIM_BUILD_WORKERS -> experimental.cpus in next.config.ts), and it sizes that
// fleet by memory rather than by cores: as many workers as can each hold a
// share big enough to finish, never more than the box has cores to run.
//
// availableParallelism() stays the cores ceiling — it does respect cpuset and
// cgroup CPU limits, which is exactly what os.cpus() gets wrong.
const cores = Math.max(1, availableParallelism());
const affordableWorkers = Math.max(1, Math.floor(headroom / MIN_VIABLE_WORKER_HEAP_MB));
const workers = Math.min(cores, affordableWorkers);
const perWorker = Math.max(MIN_WORKER_HEAP_MB, Math.floor(headroom / workers));

// null means "set no flag at all": only when the box is so small that even the
// per-worker share is below the floor, where a ceiling would swap one failure
// for another instead of preventing it.
const heapMb = hasOverride
  ? override
  : headroom >= CEILING_MB
    ? CEILING_MB
    : headroom >= MIN_WORKER_HEAP_MB
      ? perWorker
      : null;

/**
 * True when this box cannot even afford the ceiling — the same measurement that
 * decides the heap flag also decides whether the build can afford to type-check.
 * Exported to the child as DIM_CONSTRAINED_BUILD and read by next.config.ts.
 *
 * Deliberately derived from the machine rather than from a vendor flag. The
 * first version of this keyed off `process.env.VERCEL`, which only exists when
 * a project has "Automatically expose System Environment Variables" enabled —
 * a setting that can be off, in which case the guard silently never fires and
 * the build fails exactly as it did before. The cgroup limit is not optional
 * and cannot be switched off in a dashboard.
 */
const constrained = headroom < CEILING_MB;

// Printed unconditionally: when a build dies of memory, the log has to already
// contain what the build believed about its own limits. Reproducing an OOM to
// find that out costs a deploy cycle — and the worker count belongs here too,
// because the ceiling only makes sense next to how many processes will hold one.
console.log(
  hasOverride
    ? `[build] heap ceiling ${heapMb} MB (BUILD_HEAP_MB override)`
    : constrained
      ? `[build] heap ceiling ${heapMb ?? "unset"} MB per worker × ${workers} worker(s) pinned (${cores} core(s) available) — ${detected.mb} MB available via ${detected.source}; constrained box, so the build also skips its type pass`
      : `[build] heap ceiling ${heapMb} MB — ${detected.mb} MB available via ${detected.source}`,
);

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

// Appended, not assigned: an inherited NODE_OPTIONS may already carry flags
// this script has no business dropping.
const nodeOptions = [
  process.env.NODE_OPTIONS,
  heapMb === null ? null : `--max-old-space-size=${heapMb}`,
]
  .filter(Boolean)
  .join(" ");

const child = spawn(process.execPath, [nextBin, "build", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    DIM_CONSTRAINED_BUILD: constrained ? "1" : "",
    // The fleet size this script sized the heap for. next.config.ts feeds it to
    // experimental.cpus so the two agree; without it Next picks its own number
    // from the host's core count and the division above means nothing.
    //
    // Only on a constrained box: where headroom is plentiful the ceiling is the
    // flat CEILING_MB and the fleet does not need bounding, so an unconstrained
    // machine keeps exactly the build it has today.
    DIM_BUILD_WORKERS: constrained ? String(workers) : "",
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    // A signal is not an exit code. SIGKILL here is the OOM killer, and saying
    // so beats the bare "exited with 1" that sent us reading Vercel's docs.
    const hint = signal === "SIGKILL" ? " — this is almost always the out-of-memory killer." : "";
    console.error(`[build] next build was killed by ${signal}${hint}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(`[build] could not start next build: ${error.message}`);
  process.exit(1);
});
