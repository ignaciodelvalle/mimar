// Every native route carries a DECIDED header, or its absence carries a reason.
//
// THE CLASS THIS CLOSES (walkthrough 2026-08-31 §3): an Expo Router route that
// `_layout.tsx` does not register takes its header from the path segment —
// "turnos/index", lowercase, over a screen whose own title is capitalised.
// Eight accumulated precisely because nothing ever went red; this file is the
// fence the finding called "fence-shaped with no fence", wrapping the same
// recount the doc prescribes as commands.
//
// THE EXEMPTION TABLE IS NOT A LOOPHOLE — it is the integrator's rule made
// checkable: THE TITLE IS TRANSCRIBED, NOT INVENTED, and a route whose
// surfaces disagree on the string is a COPY question no merge may settle. An
// exemption names the disagreement; it dies loudly when the route disappears
// or gets registered (both directions, the REF_EXEMPT pattern from
// scripts/check-scheduled-fence-refs.ts), so it cannot outlive its argument.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP_DIR = join(process.cwd(), "apps/mobile/app");
const LAYOUT = join(APP_DIR, "_layout.tsx");

/** Routes deliberately unregistered: two surfaces, two strings — a pending
 * copy decision, written down so it can be answered instead of re-discovered.
 * Removing a route from here without registering it turns the fence red.
 *
 * EMPTY as of 2026-09-11, for the second time, and the table stays because the
 * RULE stays: the next route whose surfaces disagree gets an entry here, not an
 * invented header.
 *
 * The four answered so far, and they were answered because they were WRITTEN
 * DOWN rather than guessed:
 *   · 2026-09-01 — "Modo perdida", "Turno", "Cuidado temporal".
 *   · 2026-09-11 — `mascotas/[publicToken]/vacunas` → **"Recordatorios"**, the
 *     PO taking reading (b). The screen CANCELS reminders as well as scheduling
 *     vaccines, so the narrow noun was naming a part of the content as if it
 *     were the whole. The card that opens it already said "Recordatorios": the
 *     app had renamed, in exactly one place, the thing it was mirroring — and
 *     the answer resolves that toward the more honest name instead of back to
 *     the original. The web section was renamed with it
 *     (`PetReminders.tsx`, twice), so all three surfaces agree again.
 *
 * That is the argument for this table existing at all: an invented header is
 * unfalsifiable once shipped, and a question parked in a fence gets answered. */
const TITLE_PENDING: ReadonlyArray<{ route: string; question: string }> = [];

/**
 * NOTHING IS EXCLUDED ANY MORE, and `+not-found` is why the list is gone
 * rather than empty.
 *
 * It sat here as "Expo Router's own file — not a screen anybody navigates to by
 * name", which was true of the ROUTE and false of the SCREEN: nobody navigates
 * to it deliberately, and it is the one header in the app that is guaranteed to
 * be read by somebody arriving from OUTSIDE — a mail link, a QR — which is the
 * worst possible place to render "+not-found" out of a filename. It is now
 * registered in `_layout.tsx` with a transcribed title ("No pudimos abrir ese
 * link", NAV-M1), so the exclusion no longer describes anything: it only
 * protected the one route from the fence that would have caught the defect.
 *
 * Asserted like every other route from here on. If a future refactor drops that
 * `<Stack.Screen>`, this file goes red instead of quietly shipping a router
 * string to the person least able to interpret it.
 */

function routeFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full, `${prefix}${entry}/`));
      continue;
    }
    if (!entry.endsWith(".tsx")) continue;
    const route = `${prefix}${entry.slice(0, -".tsx".length)}`;
    if (route.endsWith("_layout")) continue;
    out.push(route);
  }
  return out.sort();
}

function registeredNames(): Set<string> {
  const source = readFileSync(LAYOUT, "utf8");
  return new Set([...source.matchAll(/name="([^"]+)"/g)].map((m) => m[1]));
}

describe("mobile screen headers — registered or exempt with a written question", () => {
  const routes = routeFiles(APP_DIR);
  const registered = registeredNames();
  const pending = new Set(TITLE_PENDING.map((e) => e.route));

  it("sees the app directory at all — the sweep must never pass on an empty set", () => {
    expect(routes.length).toBeGreaterThan(20);
    expect(registered.has("turnos/index")).toBe(true);
    // The route that used to be exempt is now in the corpus AND registered —
    // both halves, so a walk that stopped seeing it would not read as a pass.
    expect(routes).toContain("+not-found");
  });

  it("every route is registered in _layout.tsx or carries a pending copy question", () => {
    const naked = routes.filter((r) => !registered.has(r) && !pending.has(r));
    expect(
      naked,
      "Unregistered routes render their PATH as the header. Register each with a title " +
        "TRANSCRIBED from two agreeing surfaces (see _layout.tsx's own comments for the " +
        "rule), or add it to TITLE_PENDING with the copy question written out.",
    ).toEqual([]);
  });

  it("an exemption dies when its route is registered or gone — it cannot outlive its argument", () => {
    for (const e of TITLE_PENDING) {
      expect(
        routes.includes(e.route),
        `TITLE_PENDING names "${e.route}", which is not a route file any more — remove the entry.`,
      ).toBe(true);
      expect(
        registered.has(e.route),
        `TITLE_PENDING names "${e.route}", but _layout.tsx now registers it — the copy question was answered, so remove the entry.`,
      ).toBe(false);
    }
  });
});
