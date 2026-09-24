// The four-way union, proved without a database.
//
// WHY THIS TEST EXISTS AT ALL. Until Track 2 the four outcomes of a public
// token — throttled, not_found, degraded, ok — were four inline branches of a
// React server component, so the only way to assert "a rejected view-data load
// degrades WITH the pet name, not bare" was to render a page against a mocked
// drizzle chain and inspect the element tree. The mapping is now a function
// with injected collaborators, so each outcome is one assertion.
//
// The distinctions that matter, and each is a real bug someone could ship:
//   • throttled must not read the pet row AT ALL (the limiter is the point).
//   • not_found must never be returned for a DB failure — an outage is not
//     "this token does not exist", and answering 404 to a finder standing over
//     a lost animal is the worst possible lie this surface can tell.
//   • degraded has TWO shapes: bare (the pet row itself failed — the token is
//     all we know) and rich (the row resolved, so name + lost CTAs survive).
//     Collapsing them drops the finder's only reachable action.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pet } from "@/db";
import { RateLimitError } from "@/lib/infra/rate-limit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CredentialViewData } from "./load-public-credential";
import {
  type LookupDeps,
  PET_ROW_BUDGET_MS,
  type PublicCredentialPetRow,
  type PublicTokenThrottle,
  VIEW_DATA_BUDGET_MS,
  lookupPublicCredential,
  selectPublicCredentialPetRow,
} from "./lookup-public-credential";

// The door reports every limiter failure it swallows; the fail-open test below
// asserts the report, so the real implementation is replaced rather than spied.
const mockReportError = vi.fn();
vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_TOKEN = "DIM-PAMP-0001";

/** Only the fields the union reads. Cast because `Pet` is the full row type and
 *  enumerating 60 columns here would test the schema, not the mapping. */
const LOST_PET = {
  id: "pet-1",
  name: "Pampa",
  sex: "female",
  status: "lost",
  allowFinderFormWhenLost: true,
  publicToken: PUBLIC_TOKEN,
} as unknown as Pet;

const VIEW_DATA = {
  canonicalIds: { microchip: null, tattoo: null },
} as unknown as CredentialViewData;

function petRow(photoPath: string | null = null): PublicCredentialPetRow {
  return {
    pet: LOST_PET,
    photo: photoPath ? ({ storagePath: photoPath } as PublicCredentialPetRow["photo"]) : null,
  };
}

/** Records the order collaborators ran in — the throttle-before-lookup proof. */
let calls: string[] = [];

function throttleStub(throttled: boolean): PublicTokenThrottle {
  return {
    bucket: "public_token_page",
    isThrottled: vi.fn(async () => {
      calls.push("throttle");
      return throttled;
    }),
  };
}

function depsStub(overrides: Partial<LookupDeps> = {}): LookupDeps {
  return {
    findPet: vi.fn(async () => {
      calls.push("findPet");
      return petRow();
    }),
    loadViewData: vi.fn(async () => {
      calls.push("loadViewData");
      return VIEW_DATA;
    }),
    // Pass-through: the budget wrapper's own timeout semantics are covered by
    // lib/infra/db-budget's tests. What this file asserts is that the RIGHT
    // budget and label reach it — see the budgets test below.
    withBudget: vi.fn((promise) => promise),
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  mockReportError.mockClear();
  // reportError writes one structured JSON line to stderr on every degraded
  // path; silenced so a passing run stays readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// The four outcomes
// ---------------------------------------------------------------------------

describe("lookupPublicCredential — the four-way union", () => {
  it("answers throttled WITHOUT reading any pet data", async () => {
    const deps = depsStub();

    const result = await lookupPublicCredential(
      { publicToken: PUBLIC_TOKEN, throttle: throttleStub(true) },
      deps,
    );

    expect(result).toEqual({ status: "throttled" });
    // The whole point of a read limiter: nothing was read.
    expect(deps.findPet).not.toHaveBeenCalled();
    expect(deps.loadViewData).not.toHaveBeenCalled();
  });

  it("awaits the throttle BEFORE the pet lookup", async () => {
    await lookupPublicCredential(
      { publicToken: PUBLIC_TOKEN, throttle: throttleStub(false) },
      depsStub(),
    );

    // A limiter that runs after the lookup has already hit the database bounds
    // nothing. Order, not mere presence.
    expect(calls).toEqual(["throttle", "findPet", "loadViewData"]);
  });

  it("FAILS OPEN when the limiter itself throws — the door owns that guarantee", async () => {
    // The docblock claimed fail-open, but the claim described ONE adapter's
    // internals. A port is anything a caller passes: the route handler's, a
    // native client's, a test double. An unguarded `await` here means the
    // limiter — itself a DB write — becomes the thing that breaks the
    // credential before the degraded render can happen, which is the exact
    // inversion this surface must never have.
    const exploding: PublicTokenThrottle = {
      bucket: "public_token_api_credential",
      isThrottled: vi.fn(async () => {
        calls.push("throttle");
        throw new Error("limiter storage unavailable");
      }),
    };
    const deps = depsStub();

    const result = await lookupPublicCredential(
      { publicToken: PUBLIC_TOKEN, throttle: exploding },
      deps,
    );

    // Open, not closed: the finder in the street still gets the credential.
    expect(result.status).toBe("ok");
    expect(calls).toEqual(["throttle", "findPet", "loadViewData"]);
    // And it is not silent — a limiter that stopped working is an incident.
    expect(mockReportError).toHaveBeenCalledWith("public-credential/throttle", expect.any(Error), {
      bucket: "public_token_api_credential",
    });
  });

  it("answers THROTTLED when the port signals the limit by throwing RateLimitError", async () => {
    // FAIL-OPEN IS RIGHT FOR A BROKEN LIMITER AND WRONG FOR A HIT ONE, and the
    // catch above could not tell them apart: `catch (err) { continue }` turned
    // the one rejection that MEANS "throttled" into "not throttled". It is not a
    // hypothetical port either — `enforceRateLimit`, the limiter every other
    // anonymous surface in this codebase uses, reports a limit hit by throwing
    // exactly this class (report-pet-sighting.ts, report-dispute-tip.ts). Any
    // adapter built on it — a native client's, an API route's — would have had
    // its limit silently converted into a served credential.
    const limitHit: PublicTokenThrottle = {
      bucket: "public_token_api_credential",
      isThrottled: vi.fn(async () => {
        calls.push("throttle");
        throw new RateLimitError(new Date(Date.now() + 60_000), "public_token_api_credential");
      }),
    };
    const deps = depsStub();

    const result = await lookupPublicCredential(
      { publicToken: PUBLIC_TOKEN, throttle: limitHit },
      deps,
    );

    expect(result).toEqual({ status: "throttled" });
    // The whole point, again: nothing was read.
    expect(deps.findPet).not.toHaveBeenCalled();
    expect(deps.loadViewData).not.toHaveBeenCalled();
    // And it is NOT an incident. A limiter that enforced its limit is working;
    // reporting it would bury the reports that mean something.
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("answers not_found when the token resolves to no row", async () => {
    const result = await lookupPublicCredential(
      { publicToken: PUBLIC_TOKEN, throttle: throttleStub(false) },
      depsStub({ findPet: vi.fn(async () => undefined) }),
    );

    expect(result).toEqual({ status: "not_found" });
  });

  it("answers degraded BARE when the pet row itself fails", async () => {
    const deps = depsStub({
      findPet: vi.fn(async () => {
        throw new Error("pool exhausted");
      }),
    });

    const result = await lookupPublicCredential(
      { publicToken: PUBLIC_TOKEN, throttle: throttleStub(false) },
      deps,
    );

    // Never not_found: a DB outage is not "this token does not exist".
    expect(result).toEqual({ status: "degraded", publicToken: PUBLIC_TOKEN });
    expect(result.status === "degraded" && result.pet).toBeUndefined();
    // The fan-out is never attempted without a pet.
    expect(deps.loadViewData).not.toHaveBeenCalled();
  });

  it("answers degraded WITH the pet fields when the view-data fan-out fails", async () => {
    const result = await lookupPublicCredential(
      { publicToken: PUBLIC_TOKEN, throttle: throttleStub(false) },
      depsStub({
        loadViewData: vi.fn(async () => {
          throw new Error("budget exceeded");
        }),
      }),
    );

    // Exactly the props the degraded credential card renders: without these the
    // finder loses the name and both aviso CTAs, which run their own reads and
    // may still work.
    expect(result).toEqual({
      status: "degraded",
      publicToken: PUBLIC_TOKEN,
      pet: { name: "Pampa", sex: "female", isLost: true, allowFinderForm: true },
    });
  });

  it("answers ok with the pet, the photo URL and the view data", async () => {
    const result = await lookupPublicCredential(
      { publicToken: PUBLIC_TOKEN, throttle: throttleStub(false) },
      depsStub({ findPet: vi.fn(async () => petRow("pampa.jpg")) }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.pet).toBe(LOST_PET);
    expect(result.data).toBe(VIEW_DATA);
    // Resolved here so neither renderer needs to know the bucket layout.
    expect(result.photoUrl).toContain("/pet-photos/pampa.jpg");
  });

  it("answers ok with a null photo URL when the pet has no primary photo", async () => {
    const result = await lookupPublicCredential(
      { publicToken: PUBLIC_TOKEN, throttle: throttleStub(false) },
      depsStub(),
    );

    expect(result.status === "ok" && result.photoUrl).toBeNull();
  });

  it("bounds each read with its own budget and label", async () => {
    const deps = depsStub();

    await lookupPublicCredential(
      { publicToken: PUBLIC_TOKEN, throttle: throttleStub(false) },
      deps,
    );

    // The budgets travel WITH the reads (they moved out of the page), so the
    // route handler inherits the page's numbers instead of copying them.
    expect(deps.withBudget).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      PET_ROW_BUDGET_MS,
      "GET /p/[publicToken] pet-row",
    );
    expect(deps.withBudget).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      VIEW_DATA_BUDGET_MS,
      "GET /p/[publicToken] view-data",
    );
    expect(PET_ROW_BUDGET_MS).toBe(3000);
    expect(VIEW_DATA_BUDGET_MS).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// selectPublicCredentialPetRow — the query shared by the door and the probe.
// ---------------------------------------------------------------------------

describe("selectPublicCredentialPetRow — refuses an unfiltered read", () => {
  it("throws on an undefined predicate instead of resolving the table's first row", async () => {
    // `and(undefined, isNull(pets.deletedAt))` collapses to just the
    // soft-delete clause — "the first non-deleted pet" rather than "the pet
    // matching this token". Every real caller passes `publicPetByToken(x)`,
    // which never returns undefined; this proves a caller mistake fails loudly
    // instead of leaking an arbitrary pet row, and it never reaches `db` (which
    // this file does not mock) because the guard runs before the query.
    await expect(selectPublicCredentialPetRow(undefined)).rejects.toThrow(
      /tokenPredicate is undefined/,
    );
  });
});

// ---------------------------------------------------------------------------
// The caller set is pinned, not left open — same discipline as the alias
// census in __tests__/public-token-throttle-coverage.test.ts (ALIAS_RESOLVERS):
// exactly the door (this file, its own `findPetByPublicToken`) and the landing
// layout's probe may call this query, checked in both directions so a THIRD
// caller (a future route reimplementing the pet-row read) fails loudly rather
// than silently drifting from the guarded, soft-delete-filtered shape.
// ---------------------------------------------------------------------------

describe("selectPublicCredentialPetRow — the caller set is pinned", () => {
  it("is called by exactly the door file and the credential probe — nowhere else", () => {
    const CALL = "selectPublicCredentialPetRow(";
    const EXPECTED_CALLERS = [
      "app/(public)/p/[publicToken]/credential-probe.ts",
      "src/modules/pets/application/read/lookup-public-credential.ts",
    ].sort((a, b) => a.localeCompare(b));

    const root = join(__dirname, "..", "..", "..", "..", "..");
    const callers: string[] = [];
    for (const scanRoot of ["app", "src"] as const) {
      const abs = join(root, scanRoot);
      for (const entry of readdirSync(abs, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
        if (entry.name.includes(".test.")) continue;
        const file = join(entry.parentPath, entry.name);
        const src = readFileSync(file, "utf8");
        if (!src.includes(CALL)) continue;
        callers.push(file.slice(root.length + 1).replaceAll("\\", "/"));
      }
    }
    expect(callers.sort((a, b) => a.localeCompare(b))).toEqual(EXPECTED_CALLERS);
  });
});
