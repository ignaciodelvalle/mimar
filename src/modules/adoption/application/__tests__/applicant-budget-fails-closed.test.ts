// `spendApplicantBudget` FAILS CLOSED — the claim, measured.
//
// ===========================================================================
// WHY THIS IS ITS OWN FILE
// ===========================================================================
// `submit-adoption-application.test.ts` injects a FAKE budget on every call, on
// purpose (the real one writes to `rate_limit_buckets`, and a unit test that hit
// it would start failing on the thirty-first run of a day). The consequence is
// that the real `spendApplicantBudget` — the function whose behaviour the
// endpoint's whole failure story rests on — was never executed by anything.
//
// The WU-U hand-off's title claimed the flow "fails CLOSED, deliberately
// inverting the failure-open of the erasure", and that was an unmeasured
// sentence. Flipping `return "denied"` to `return "ok"` in the catch left every
// test in the module green. Five sibling files in this repo carry a test
// literally named "FAILS OPEN when the limiter itself is broken"; the inverse
// deserved one too, and it is the more dangerous direction to get wrong.
//
// WHAT THE INVERSION IS FOR. `eraseSubjectDataFor` fails OPEN because an abuse
// control must not stand between a person and a legal right. `POST /me/
// notifications` fails open because refusing would lock somebody out of their
// own inbox. Neither reason holds here: nobody has a legal right to apply for
// an adoption, nothing of the applicant's is withheld by waiting, and what an
// outage would otherwise open is unmetered writes into every shelter's review
// queue — the one resource on this surface that is not the caller's own.
//
// Every test names the mutation that reddens it. All five were applied.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  throws: null as null | (() => never),
  calls: [] as Array<{ endpoint: string; identifier: string }>,
  reported: [] as string[],
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.calls.push({ endpoint, identifier });
      control.throws?.();
    },
  };
});

vi.mock("@/lib/infra/report-error", () => ({
  reportError: (label: string) => {
    control.reported.push(label);
  },
}));

import { RateLimitError } from "@/lib/infra/rate-limit";

import {
  ADOPTION_APPLICATION_USER_BUCKET,
  ADOPTION_APPLICATION_USER_LIMIT,
} from "../adoption-application-limits";
import { spendApplicantBudget } from "../submit-adoption-application";

const ME = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  control.throws = null;
  control.calls = [];
  control.reported = [];
});

describe("spendApplicantBudget", () => {
  it("spends the SHARED bucket keyed on the applicant, so both doors meet one ceiling", async () => {
    // THE BUCKET NAME IS THE POINT. It is `adoption_application_user` and not
    // `api_v1_…`, because the web form spends the same counter — a ceiling that
    // belongs to the transport is a ceiling a caller escapes by using the other
    // door.
    //
    // MUTATIONS APPLIED, both red: rename the bucket to `api_v1_adoption_apply`,
    // and pass a constant instead of `userId` (which would give every applicant
    // in the country one shared budget).
    //
    // THE NAME IS ASSERTED AS A LITERAL AND NOT AGAINST ITS OWN CONSTANT. The
    // first version of this test read
    // `{ endpoint: ADOPTION_APPLICATION_USER_BUCKET, ... }`, which is `a === a`:
    // the rename mutation moved both sides together and SURVIVED. Only the
    // literal, plus the shape rule underneath it, actually says anything.
    await expect(spendApplicantBudget(ME)).resolves.toBe("ok");
    expect(control.calls).toEqual([{ endpoint: "adoption_application_user", identifier: ME }]);
    // AND IT MUST NOT LOOK LIKE A TRANSPORT'S BUDGET. `SUBJECT_DATA_ERASURE_
    // USER_BUCKET` and `REVOKE_SESSIONS_USER_BUCKET` give the rule: a bucket
    // spent by both a web form and a bearer door may not be named `api_v1_...`,
    // because that name reads like a second budget and the whole point is that
    // there is one.
    expect(ADOPTION_APPLICATION_USER_BUCKET).toBe("adoption_application_user");
    expect(ADOPTION_APPLICATION_USER_BUCKET.startsWith("api_v1")).toBe(false);
  });

  it("DENIES a spent budget, and reports nothing — that is not an incident", async () => {
    // MUTATION APPLIED: drop the `instanceof RateLimitError` narrowing, so an
    // ordinary 429 is reported as a system fault. Red on the second assertion —
    // and the cost of that mutation is an alerting channel that cries wolf every
    // time somebody fills a form twice, which is how a real outage gets ignored.
    control.throws = () => {
      throw new RateLimitError(new Date(Date.now() + 60_000), ADOPTION_APPLICATION_USER_BUCKET);
    };
    await expect(spendApplicantBudget(ME)).resolves.toBe("denied");
    expect(control.reported).toEqual([]);
  });

  it("DENIES when the limiter itself is broken — this is the fail-CLOSED half", async () => {
    // THE ONE THE HAND-OFF CLAIMED AND DID NOT MEASURE.
    //
    // MUTATION APPLIED: `return "ok"` in the catch. Green across the entire
    // adoption module, because every other test injects a fake budget — and in
    // production a limiter outage would become unmetered writes into every
    // shelter's review queue, which is precisely the abuse this ceiling exists
    // for. Red here alone.
    control.throws = () => {
      throw new Error("rate_limit_buckets unreachable");
    };
    await expect(spendApplicantBudget(ME)).resolves.toBe("denied");
  });

  it("REPORTS the broken limiter, because failing closed silently is its own outage", async () => {
    // A door that quietly refuses every application is indistinguishable, from
    // the outside, from a product nobody is using.
    //
    // MUTATION APPLIED: delete the `reportError` call. Red.
    control.throws = () => {
      throw new Error("rate_limit_buckets unreachable");
    };
    await spendApplicantBudget(ME);
    expect(control.reported).toEqual(["adoption/submit-application-limit"]);
  });

  it("fails in the OPPOSITE direction from the route's per-IP gate, on the same outage", async () => {
    // THE TWO HALVES OF THE ENDPOINT'S FAILURE STORY, ASSERTED TOGETHER, because
    // the whole argument only works as a pair and each half lives in a different
    // file. `app/api/v1/adoptions/[petToken]/route.ts`'s `spendBudget` returns
    // `true` on a broken limiter — its job is to refuse an unauthenticated
    // hammer before the GoTrue round-trip, not to bound the act — and it is
    // ALLOWED to, precisely because this one still refuses.
    //
    // Somebody unifying the two "for consistency" would produce either an
    // outage that refuses every browse (harmless-looking, wrong) or an outage
    // that opens unmetered writes into every shelter's queue. This line is what
    // they meet first. The route's half is pinned in
    // `__tests__/api-v1-adoptions-route.test.ts` ("FAILS OPEN on the WRITE too").
    //
    // MUTATION APPLIED: `return "ok"` in the catch — red here as well as in the
    // test above it, so the pair reads as one broken invariant rather than one
    // failing assertion.
    control.throws = () => {
      throw new Error("rate_limit_buckets unreachable");
    };
    const perApplicant = await spendApplicantBudget(ME);
    const perIpUnderTheSameOutage = "proceeds" as const;
    expect({ perApplicant, perIpUnderTheSameOutage }).toEqual({
      perApplicant: "denied",
      perIpUnderTheSameOutage: "proceeds",
    });
  });

  it("runs on a THREE-window ceiling whose day is the binding one", async () => {
    // NON-VACUITY for the assertions above: a limit object with every window
    // undefined would let `enforceRateLimit` pass unconditionally and leave
    // every "denied" test above depending only on the injected throw.
    //
    // MUTATION APPLIED: `maxPerDay: undefined` on the constant. Red — and the
    // day window is the one that bounds the abuse this ceiling exists for, since
    // a carpet-bomb across every listed animal in the country is a slow loop and
    // the hourly window resets 24 times while it runs.
    expect(ADOPTION_APPLICATION_USER_LIMIT.maxPerMinute).toBeGreaterThan(0);
    expect(ADOPTION_APPLICATION_USER_LIMIT.maxPerHour).toBeGreaterThan(0);
    expect(ADOPTION_APPLICATION_USER_LIMIT.maxPerDay).toBeGreaterThan(0);
  });
});
