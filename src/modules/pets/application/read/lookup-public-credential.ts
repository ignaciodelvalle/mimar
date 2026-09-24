// The public credential's ONE door: token in, a four-way answer out.
//
// WHY A UNION AND NOT FOUR FUNCTIONS (Track 2, item 3)
// ---------------------------------------------------------------------------
// `loadCredentialViewData` (sibling file) already moved every post-pet-row read
// out of the page. What stayed behind was the part a native client actually
// needs and cannot get: the DECISION. Four outcomes — throttled, not_found,
// degraded, ok — lived as four inline branches inside a React server component,
// so the only way to ask "what does this token resolve to?" was to render HTML
// and read it back.
//
// `GET /api/v1/pets/{token}/credential` and the page now sit on THIS function.
// One door, two renderers. The alternative — a route handler that re-implements
// the same four branches — is how the JSON and the HTML start disagreeing about
// what "degraded" means, which is exactly the failure the per-section degraded
// contract exists to prevent (RN-8 #6: a native client renders a blank section
// as "a valid credential with no findings").
//
// WHY THE THROTTLE IS A PORT AND NOT AN IMPORT
// ---------------------------------------------------------------------------
// `isPublicTokenReadThrottled` reads the caller IP, which means it calls
// `next/headers`. The application fence (biome nursery/noRestrictedImports over
// src/modules/*/application/**, ADR 2026-07-18 Decision 1) bans that specifier
// here, and rightly: a use-case must run without a Next request, because a
// React Native app has no Next request to give it.
//
// So the limiter arrives as a PARAMETER. That is not a workaround for the
// fence — it is the stronger form. `throttle` is REQUIRED, so a caller cannot
// reach the pet row without handing over a limiter; the enforcement is the type
// checker, not a grep over route files hoping every author remembered. The
// adapter that binds it to a real request lives in
// lib/infra/public-token-throttle.ts (`publicTokenThrottle(bucket)`), one line,
// on the infrastructure side of the boundary where `next/headers` belongs.
//
// WHY `deps` EXISTS
// ---------------------------------------------------------------------------
// The three collaborators (find the pet row, load the view data, bound them)
// are injectable so the UNION MAPPING is testable without Postgres. The four
// outcomes are the contract; proving "a rejected view-data load yields degraded
// WITH the pet fields, not bare" should not require a database, and before this
// it required rendering a page against a mocked drizzle chain.

import { type Pet, attachments, db, pets } from "@/db";
import { withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { RateLimitError } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { petPhotoUrl } from "@/lib/infra/storage";
import { type SQL, and, eq, isNull } from "drizzle-orm";
import { type CredentialViewData, loadCredentialViewData } from "./load-public-credential";

// DB time budgets (public-surface resilience). The QR credential is the one
// surface an anonymous finder in the street depends on — it must NEVER hang
// with a degraded DB or crash on a DB failure. Every read is bounded and every
// failure path answers `degraded` instead of throwing. Budgets are generous for
// the shared micro DB under load, short enough that the finder gets an honest
// degraded card rather than a spinner. They live HERE, with the reads they
// bound, so the route handler inherits the same numbers as the page instead of
// copying them. (`METADATA_BUDGET_MS` stays in the page: it bounds
// `generateMetadata`, which is a Next-specific read this door does not make.)
export const PET_ROW_BUDGET_MS = 3000;
export const VIEW_DATA_BUDGET_MS = 5000;

/**
 * The per-IP read limiter, as a port.
 *
 * `bucket` travels with it so a caller reads as one statement naming the
 * surface being limited, and so a logged port can say which counter it spends.
 */
export type PublicTokenThrottle = {
  readonly bucket: string;
  isThrottled(): Promise<boolean>;
};

/** The pet row plus its primary photo — the ONE read the degraded card needs. */
export type PublicCredentialPetRow = {
  pet: Pet;
  photo: typeof attachments.$inferSelect | null;
};

/**
 * What a public token resolves to. Every caller must handle all four:
 *
 * - `throttled`  — over the per-IP read limit. NO pet data was read.
 * - `not_found`  — the token resolves to nothing (or to a soft-deleted pet).
 * - `degraded`   — a read failed or exceeded its budget. `pet` is present only
 *                  when the pet ROW itself resolved before the failure; the
 *                  bare shape is the pet-row failure, where the token is all
 *                  that is known. Never conflate this with `not_found`: a DB
 *                  outage is not "this token does not exist".
 * - `ok`         — pet row, photo URL and the full view-data fan-out.
 */
export type PublicCredentialLookup =
  | { status: "throttled" }
  | { status: "not_found" }
  | {
      status: "degraded";
      publicToken: string;
      /** Present only when the pet row resolved — exactly the fields the
       *  degraded credential card renders (name, sex, lost CTAs). */
      pet?: {
        name: string;
        sex: Pet["sex"];
        isLost: boolean;
        allowFinderForm: boolean;
      };
    }
  | {
      status: "ok";
      pet: Pet;
      /** Resolved here rather than handed out as a storage path: both
       *  renderers want a URL, and neither should know the bucket layout. */
      photoUrl: string | null;
      data: CredentialViewData;
    };

/** The three collaborators, injectable so the union mapping is unit-testable. */
export type LookupDeps = {
  findPet: (publicToken: string) => Promise<PublicCredentialPetRow | undefined>;
  loadViewData: (pet: Pet) => Promise<CredentialViewData>;
  withBudget: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
};

/**
 * Resolve a public credential token to one of four outcomes.
 *
 * ORDER IS THE CONTRACT: the throttle runs FIRST, before any pet data is read.
 * A limiter that runs after the lookup has already hit the database bounds
 * nothing (see __tests__/public-token-throttle-coverage.test.ts, which fences
 * exactly this).
 */
export async function lookupPublicCredential(
  input: { publicToken: string; throttle: PublicTokenThrottle },
  deps: LookupDeps = {
    findPet: findPetByPublicToken,
    loadViewData: loadCredentialViewData,
    withBudget: withDbBudgetOrThrow,
  },
): Promise<PublicCredentialLookup> {
  const { publicToken, throttle } = input;

  // V1-1: rate-limit per IP before touching any pet data. The caller renders a
  // soft notice (not a hard 429) so the surface degrades gracefully.
  //
  // FAILING OPEN IS THE DOOR'S GUARANTEE, NOT AN ADAPTER'S. The limiter is
  // itself a DB write, so it must never be the thing that breaks the credential
  // before the degraded render can happen. lib/infra/public-token-throttle.ts
  // does swallow its own failures — but a PORT is whatever a caller passes: the
  // route handler's adapter, a native client's, a test double. Leaving the
  // guarantee to the implementation means the promise holds for exactly one of
  // them, and the finder standing over a lost animal is the one who finds out.
  // Every failure is reported: a limiter that stopped working is an incident,
  // even though the request continues.
  //
  // EXCEPT THE ONE REJECTION THAT MEANS "THROTTLED". Failing open is right for a
  // BROKEN limiter and exactly wrong for a HIT one, and a bare catch cannot tell
  // them apart. `enforceRateLimit` — the limiter every other anonymous surface
  // here uses — signals a limit hit by THROWING RateLimitError, so any adapter
  // built on it (a native client's, an API route's) would have had its enforced
  // limit converted into a served credential by the catch below. A throw is a
  // legitimate way for a port to say "throttled"; it is answered, not reported.
  // The adapter that ships today (lib/infra/public-token-throttle.ts) catches
  // RateLimitError itself and returns `true`, so this branch is unreachable
  // through it — which is the point: it guards the PORT's contract, not that one
  // implementation's, and the port is what a caller is free to replace.
  let throttled = false;
  try {
    throttled = await throttle.isThrottled();
  } catch (err) {
    if (err instanceof RateLimitError) return { status: "throttled" };
    reportError("public-credential/throttle", err, { bucket: throttle.bucket });
  }
  if (throttled) return { status: "throttled" };

  // Pet row — the ONE read the degraded card depends on for name/status. On
  // failure or budget exhaustion, degrade honestly.
  let row: PublicCredentialPetRow | undefined;
  try {
    row = await deps.withBudget(
      deps.findPet(publicToken),
      PET_ROW_BUDGET_MS,
      "GET /p/[publicToken] pet-row",
    );
  } catch (err) {
    reportError("public-credential/pet-row", err, { publicToken });
    return { status: "degraded", publicToken };
  }

  if (!row) return { status: "not_found" };

  const { pet, photo } = row;

  // Every remaining read (Stage 1 fan-out, amendments, service-dog row,
  // lost-mode context, tattoo photo) is one budgeted unit. On failure the
  // answer is degraded WITH the pet fields — name and lost CTAs survive,
  // because the aviso routes run their own reads and may still work.
  let data: CredentialViewData;
  try {
    data = await deps.withBudget(
      deps.loadViewData(pet),
      VIEW_DATA_BUDGET_MS,
      "GET /p/[publicToken] view-data",
    );
  } catch (err) {
    reportError("public-credential/view-data", err, { publicToken });
    return {
      status: "degraded",
      publicToken,
      pet: {
        name: pet.name,
        sex: pet.sex,
        isLost: pet.status === "lost",
        allowFinderForm: pet.allowFinderFormWhenLost,
      },
    };
  }

  return { status: "ok", pet, photoUrl: petPhotoUrl(photo?.storagePath), data };
}

/**
 * Default `findPet`: the pet row + primary photo for a public token.
 *
 * PO-4: soft-deleted pets do not resolve publicly, and the filter lives in the
 * QUERY (`publicPetByToken`), not in a post-fetch guard — an erased subject's
 * pet row must not be read into server memory at all.
 *
 * Declared BELOW the door on purpose: the throttle is the first statement a
 * reader (and the coverage fence) meets in this file, and the plumbing follows.
 */
async function findPetByPublicToken(
  publicToken: string,
): Promise<PublicCredentialPetRow | undefined> {
  return selectPublicCredentialPetRow(publicPetByToken(publicToken));
}

/**
 * THE pet-row query — pet + primary photo, first match — for a caller-supplied
 * predicate. Defined once so the door's `findPet` above and the landing
 * layout's probe (app/(public)/p/[publicToken]/credential-probe.ts) cannot
 * drift apart (they were two copies until 2026-09-23, third pass).
 *
 * It takes the WHERE clause rather than the token on purpose, and that is what
 * keeps the throttle fence honest: this export names no token lookup, so it is
 * not an unguarded resolver. Every caller writes `publicPetByToken(token)`
 * itself, in its own guarded block, where
 * __tests__/public-token-throttle-coverage.test.ts can see the lookup and hold
 * it to the throttle-first order. Declared LAST so `findPetByPublicToken`
 * stays inside the door's export block.
 *
 * SOFT-DELETE IS ENFORCED HERE TOO (PO-4), not left to the caller's predicate.
 * Taking a WHERE clause means a future caller could pass a bare
 * `eq(pets.publicToken, …)`; the soft-delete census reads `pets` access per
 * file, and would not see that caller at all. So an erased pet never resolves
 * through this query whatever predicate arrives — the filter is redundant with
 * `publicPetByToken` today, on purpose.
 */
export async function selectPublicCredentialPetRow(
  tokenPredicate: SQL | undefined,
): Promise<PublicCredentialPetRow | undefined> {
  // An `undefined` predicate is not "no filter" here — `and(undefined,
  // isNull(pets.deletedAt))` collapses to just the soft-delete clause, which
  // would turn this into "the first non-deleted pet in the table" instead of
  // "the pet matching this token". Every caller passes `publicPetByToken(x)`,
  // which itself never returns undefined, so this can only fire on a caller
  // mistake — and failing loudly beats silently leaking an arbitrary pet row.
  if (tokenPredicate === undefined) {
    throw new Error(
      "selectPublicCredentialPetRow: tokenPredicate is undefined — refusing to resolve an unfiltered row",
    );
  }
  const [row] = await db
    .select({ pet: pets, photo: attachments })
    .from(pets)
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .where(and(tokenPredicate, isNull(pets.deletedAt)))
    .limit(1);
  return row;
}
