// Shared Vitest setup — env loading + Supabase belt-and-suspenders. Loaded by
// BOTH projects (unit + db).
//
// This half of the old __tests__/setup.ts makes .env.local / .env values
// available to any test that reads process.env (feature flags, NEXT_PUBLIC_*
// copy, keys). DATABASE_URL forcing still lives in __tests__/setup.ts (db
// project only — the only project whose files can reach the Drizzle client;
// see __tests__/db-reachability.ts).
//
// SUPABASE URL + SERVICE KEY, however, are forced to the LOCAL stack here for
// BOTH projects (Wave M hardening, Tren 1 review finding): a unit test that
// builds its own supabase-js client from env would otherwise talk to whatever
// remote project .env.local points at. The reachability classifier now also
// treats such tests as "db" (DIRECT_DB_SIGNAL_RE Supabase signals) — this
// forcing is the second, independent belt: even a test the classifier misses
// can only ever hit 127.0.0.1. Values/logic mirror __tests__/setup.ts.

import { config as loadEnv } from "dotenv";
import { afterEach } from "vitest";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// GLOBAL RTL AUTO-CLEANUP — unmount every React tree between tests.
//
// React Testing Library installs its own auto-cleanup only when a GLOBAL
// `afterEach` exists (it probes for one at import time). This repo does not set
// `globals: true`, so RTL's probe fails and NOTHING ever unmounts on its own:
// every `render()` / `renderHook()` leaves its container and its React root
// attached to the jsdom document for the rest of the file. ~115 test files use
// RTL; only two thirds call `cleanup()` by hand.
//
// The failure mode is not cosmetic. A left-mounted root keeps effects, timers
// and pending state updates alive past the test that created them; when the
// worker is torn down they run against a dead environment. That is exactly how
// an async `renderHook` put CI red with "1 error / 0 tests failing" (e730e4e2).
//
// Registered here rather than in setup.ts because setup-env.ts is the "unit"
// project's setup file AND is imported by the "db" project's setup.ts — one
// registration covers BOTH projects.
//
// GUARDED on `document` because the default test environment is node: most
// files in both projects have no DOM at all, and RTL's `cleanup()` throws
// without one. The import is DYNAMIC for the same reason — a static import
// would pull react-dom into every pure-Node test file. Module resolution is
// cached after the first DOM file, so the cost is paid once per worker.
afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

// Local Supabase defaults (supabase start) — keep custom local hosts if set.
const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
// New-style local key from `supabase status`. Universal across local stacks
// of the same supabase-cli version family.
const LOCAL_SERVICE_KEY = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

function isLocalUrl(u: string | undefined): boolean {
  return !!u && (u.includes("127.0.0.1") || u.includes("localhost"));
}

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !isLocalUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_SUPABASE_URL;
}

if (
  !process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY.startsWith("eyJ") // legacy JWT
) {
  // Either no key, or a JWT key (likely a remote project's). Replace with the
  // local-stack secret so an env-built client can never auth against remote.
  process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_KEY;
}
