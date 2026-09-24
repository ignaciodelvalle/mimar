// The relationships the adoption-application ceilings committed to.
//
// NOT THE DIGITS — the relationships, for the reason `login-limits.ts` gives and
// `api-v1-rate-limit-families.test.ts` repeats: a formula would make a fence
// assert `a === a`, and would let somebody raise the per-USER ceiling — the
// bucket that bounds a person — and take a twelvefold raise on the per-IP one
// along with it without meeting a single argument. Literals plus an asserted
// product make that edit fail loudly.

import { describe, expect, it } from "vitest";

import {
  API_V1_ADOPTION_APPLICATION_IP_LIMIT,
  API_V1_MEDIA_UPLOAD_USER_LIMIT,
  API_V1_PET_RECORD_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";

import {
  ADOPTION_APPLICATION_SIMULTANEOUS_CALLERS,
  ADOPTION_APPLICATION_USER_LIMIT,
} from "../adoption-application-limits";

describe("the adoption-application ceilings", () => {
  it("keeps the per-IP ceiling at N simultaneous callers on BOTH windows", () => {
    // ACROSS A MODULE BOUNDARY, on purpose. The per-IP half lives in
    // `lib/infra/api-v1-limits.ts` (it is a fact about the `/api/v1` surface and
    // its family map) and the per-USER anchor lives beside its use-case (it is a
    // fact about the act, and the web form spends it too). The relationship
    // between them is what nobody may break silently, so the assertion reaches
    // across rather than either half being restated on the other side.
    //
    // FLAT on both, like `API_V1_ACCOUNT_SECURITY_IP_LIMIT` and
    // `API_V1_INBOX_STATE_IP_LIMIT` and unlike the authenticated-write family's
    // split multiple: this per-user pair is already proportionate, so 12× on
    // both windows preserves its shape rather than propagating a narrowing.
    expect(API_V1_ADOPTION_APPLICATION_IP_LIMIT.maxPerMinute).toBe(
      (ADOPTION_APPLICATION_USER_LIMIT.maxPerMinute ?? 0) *
        ADOPTION_APPLICATION_SIMULTANEOUS_CALLERS,
    );
    expect(API_V1_ADOPTION_APPLICATION_IP_LIMIT.maxPerHour).toBe(
      (ADOPTION_APPLICATION_USER_LIMIT.maxPerHour ?? 0) * ADOPTION_APPLICATION_SIMULTANEOUS_CALLERS,
    );
  });

  it("uses the same twelve every per-user-anchored family on this project uses", () => {
    expect(ADOPTION_APPLICATION_SIMULTANEOUS_CALLERS).toBe(12);
  });

  it("keeps every window above zero, so the products mean something", () => {
    // THE NON-VACUITY FLOOR. `0 === 0 * 12` is true, so an anchor silently
    // zeroed would satisfy the assertion above while the ceiling it describes
    // collapsed.
    expect(ADOPTION_APPLICATION_USER_LIMIT.maxPerMinute ?? 0).toBeGreaterThan(0);
    expect(ADOPTION_APPLICATION_USER_LIMIT.maxPerHour ?? 0).toBeGreaterThan(0);
    expect(ADOPTION_APPLICATION_USER_LIMIT.maxPerDay ?? 0).toBeGreaterThan(0);
  });

  it("stays the tightest per-user WRITE budget on this surface, on all three windows", () => {
    // NOT A TASTE CHECK, and the DIRECTION is what is pinned because the number
    // is the part somebody will want to raise when a shelter complains that a
    // good applicant was refused. `API_V1_MEDIA_UPLOAD_USER_LIMIT`'s docblock
    // calls itself "the tightest per-user WRITE budget on this surface" and
    // derives that from ≈15 MB of object-store traffic per photo. This one is
    // tighter, and NOT because it costs us more — it costs us less. The
    // resource it spends is a shelter's attention, which is the one thing this
    // product cannot give back. Raising it past a photo upload has to walk past
    // this line on purpose.
    expect(ADOPTION_APPLICATION_USER_LIMIT.maxPerMinute ?? 0).toBeLessThan(
      API_V1_MEDIA_UPLOAD_USER_LIMIT.maxPerMinute ?? 0,
    );
    expect(ADOPTION_APPLICATION_USER_LIMIT.maxPerHour ?? 0).toBeLessThan(
      API_V1_MEDIA_UPLOAD_USER_LIMIT.maxPerHour ?? 0,
    );
    expect(ADOPTION_APPLICATION_USER_LIMIT.maxPerDay ?? 0).toBeLessThan(
      API_V1_MEDIA_UPLOAD_USER_LIMIT.maxPerDay ?? 0,
    );
  });

  it("carries a DAY window, which is the one that bounds the abuse it exists for", () => {
    // A carpet-bomb across every listed animal in the country is a slow loop,
    // not a burst: the hourly window resets 24 times while it runs. Two of the
    // three windows here are for retries; this is the one doing the work, and
    // `API_V1_PET_RECORD_WRITE_USER_LIMIT` is the comparison that shows what a
    // day cap is for — 300 asientos is a shelter's month of rounds, 30
    // applications is not a person choosing a companion.
    expect(ADOPTION_APPLICATION_USER_LIMIT.maxPerDay).toBeDefined();
    expect(ADOPTION_APPLICATION_USER_LIMIT.maxPerDay ?? 0).toBeLessThan(
      API_V1_PET_RECORD_WRITE_USER_LIMIT.maxPerDay ?? 0,
    );
  });
});
