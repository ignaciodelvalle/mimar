// `resolvePppRegistries` — the PPP registry list on the owner's pet detail.
//
// WHAT THIS FILE HAS TO PROVE, and it is one thing said three ways: THE THREE
// OUTCOMES ARE NOT INTERCHANGEABLE. `null` is an animal outside the regime, an
// empty array is a jurisdiction that loaded no registry, and `unavailable` is a
// read that did not answer. A client branches differently on each, and the two
// ways to get them wrong are both silent: skipping the read and reporting `[]`
// tells the form a jurisdiction chose nothing, and reporting `[]` for a failed
// lookup makes the form print a national list as if somebody had picked it.
//
// The resolver is INJECTED rather than module-mocked, so each case names the
// jurisdiction's answer in the test that depends on it.

import { describe, expect, it, vi } from "vitest";

import {
  type CheckinWindowFinder,
  resolvePostAdoptionCheckin,
} from "@/app/api/v1/pets/[publicToken]/post-adoption-checkin";
import {
  PPP_RULE_BUDGET_MS,
  type PppRuleResolver,
  resolvePppRegistries,
} from "@/app/api/v1/pets/[publicToken]/ppp-registries";

const PPP_PET = {
  potentiallyDangerousBreed: true,
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "La Plata",
};

const ORDINARY_PET = { ...PPP_PET, potentiallyDangerousBreed: false };

/** A resolver that answers with the registries given. */
function answering(registries: Array<{ id: string; label: string; required: boolean }>) {
  return vi.fn(async () => ({ payload: { registries } })) as unknown as PppRuleResolver;
}

describe("resolvePppRegistries", () => {
  it("answers null for an animal outside the regime, WITHOUT asking the rules engine", async () => {
    // The skip is half the point: one query per pet view, on every pet in the
    // product, to answer a question that has no bearing on it.
    const resolver = answering([{ id: "caba_4078", label: "CABA", required: true }]);
    const section = await resolvePppRegistries(ORDINARY_PET, resolver);

    expect(section).toEqual({ status: "ok", data: null });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("asks about the pet's OWN jurisdiction, not the country's", async () => {
    // An admin edits the rule per province and locality. Resolving it against
    // anything but the animal's own jurisdiction would give every owner the
    // same list and make the rule config theater — the defect this field was
    // added to close on the native side.
    const resolver = answering([]);
    await resolvePppRegistries(PPP_PET, resolver);

    expect(resolver).toHaveBeenCalledWith({
      country: "AR",
      province: "Buenos Aires",
      locality: "La Plata",
    });
  });

  it("maps the jurisdiction's registries onto the wire's three fields", async () => {
    const resolver = answering([
      { id: "prov_14107", label: "Prov. Bs. As. · Ley 14.107", required: true },
      { id: "muni_lp", label: "La Plata · Registro municipal", required: false },
    ]);
    const section = await resolvePppRegistries(PPP_PET, resolver);

    expect(section).toEqual({
      status: "ok",
      data: [
        { id: "prov_14107", label: "Prov. Bs. As. · Ley 14.107", required: true },
        { id: "muni_lp", label: "La Plata · Registro municipal", required: false },
      ],
    });
  });

  it("drops any field the rule's payload grows beyond those three", async () => {
    // The rule payload is a DOMAIN shape and this one is a WIRE shape. A
    // pass-through would publish, to an owner, whatever an admin form starts
    // storing next — the reason this maps field by field.
    const resolver = vi.fn(async () => ({
      payload: {
        registries: [
          { id: "caba_4078", label: "CABA · Ley 4078", required: true, internalNote: "no toca" },
        ],
      },
    })) as unknown as PppRuleResolver;
    const section = await resolvePppRegistries(PPP_PET, resolver);

    expect(section).toEqual({
      status: "ok",
      data: [{ id: "caba_4078", label: "CABA · Ley 4078", required: true }],
    });
  });

  it("reports an EMPTY LIST as a fact, distinct from a read that failed", async () => {
    // The common case in production today: the rule defaults to `{registries: []}`
    // everywhere. The form reads this as "offer the national fallback", which is
    // exactly what the web does.
    const section = await resolvePppRegistries(PPP_PET, answering([]));
    expect(section).toEqual({ status: "ok", data: [] });
  });

  it("degrades to `unavailable` when the read blows its budget, never to an empty list", async () => {
    const slow = (() =>
      new Promise(() => {
        /* never settles */
      })) as unknown as PppRuleResolver;
    const section = await resolvePppRegistries(PPP_PET, slow);

    expect(section).toEqual({ status: "unavailable" });
  }, 10_000);

  it("lets a real fault through rather than dressing it as a degraded section", async () => {
    // `unavailable` says "we could not read this in time". A constraint
    // violation is not that, and swallowing it here would hide a defect behind
    // a sentence an owner reads as a network hiccup.
    const broken = vi.fn(async () => {
      throw new Error("relation govt_business_rules does not exist");
    }) as unknown as PppRuleResolver;

    await expect(resolvePppRegistries(PPP_PET, broken)).rejects.toThrow(
      "relation govt_business_rules does not exist",
    );
  });

  it("keeps the budget tighter than the detail read it must never delay", async () => {
    // A number, asserted, because the whole degrade-alone design rests on this
    // read being the short one.
    expect(PPP_RULE_BUDGET_MS).toBeLessThan(5_000);
  });
});

// The SECOND section the route resolves itself, and the same three-outcome
// shape: a fact either way on the person path, a skipped read on the org path,
// and `unavailable` for a read that did not answer — which the app's picker
// reads as "offer the row anyway", never as "nothing pending".
describe("resolvePostAdoptionCheckin", () => {
  const OWNER = { kind: "owner" as const, petId: "pet-1", userId: "user-1" };
  const A_WINDOW = { id: "rem-1", dueAt: new Date("2026-10-01T12:00:00Z") };

  function finding(window: { id: string; dueAt: Date } | null) {
    return vi.fn(async () => window) as unknown as CheckinWindowFinder;
  }

  it("answers pending:false on the ORG path WITHOUT asking — an organization is never the adopter", async () => {
    const finder = finding(A_WINDOW);
    const section = await resolvePostAdoptionCheckin({ ...OWNER, kind: "org" }, finder);

    expect(section).toEqual({ status: "ok", data: { pending: false } });
    expect(finder).not.toHaveBeenCalled();
  });

  it("asks about THIS viewer and THIS animal, and says pending when a window is open", async () => {
    const finder = finding(A_WINDOW);
    const section = await resolvePostAdoptionCheckin(OWNER, finder);

    expect(finder).toHaveBeenCalledWith("pet-1", "user-1");
    expect(section).toEqual({ status: "ok", data: { pending: true } });
  });

  it("reports NO window as a fact, distinct from a read that failed", async () => {
    const section = await resolvePostAdoptionCheckin(OWNER, finding(null));
    expect(section).toEqual({ status: "ok", data: { pending: false } });
  });

  it("degrades to `unavailable` when the read blows its budget, never to pending:false", async () => {
    const slow = (() =>
      new Promise(() => {
        /* never settles */
      })) as unknown as CheckinWindowFinder;
    const section = await resolvePostAdoptionCheckin(OWNER, slow);

    expect(section).toEqual({ status: "unavailable" });
  }, 10_000);

  it("lets a real fault through rather than dressing it as a degraded section", async () => {
    const broken = vi.fn(async () => {
      throw new Error("relation reminders does not exist");
    }) as unknown as CheckinWindowFinder;

    await expect(resolvePostAdoptionCheckin(OWNER, broken)).rejects.toThrow(
      "relation reminders does not exist",
    );
  });
});
