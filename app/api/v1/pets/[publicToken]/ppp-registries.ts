// The registries a pet's own jurisdiction names for a PPP attestation.
//
// ITS OWN MODULE, next to `route.ts` rather than inside it, for one reason: a
// Next route file may export only the handlers and the route segment config, so
// a helper that lives there cannot be tested without going through an HTTP
// request and every guard in front of it. The rule this resolves is
// admin-editable, has three outcomes a client branches on, and one of them is a
// failure — that is worth a test that can name the case rather than construct a
// Request.
//
// WHY THE FIELD EXISTS AT ALL. The native attestation form is already CORRECT
// without it: it falls back to `DANGEROUS_BREED_REGISTRIES`, the same two
// national registries plus "Otro registro" that `buildRegistryOptions` uses on
// the web when a jurisdiction has loaded none — and that is the common case,
// because `ppp_attestation_required_registries` defaults to an empty list
// everywhere. What the field adds is the half a constant cannot have: the rule
// is resolved per province and locality and the web page re-resolves it on
// every render (atestar-raza-peligrosa/page.tsx:31). Without it, an admin
// loading CABA's registries would change what a web owner sees and not what an
// app owner sees — one door quietly telling a person something the other does
// not, which is the drift this endpoint exists to prevent.

import type { CredentialSection, OwnerPetPppRegistriesSection } from "@dim/contract/api";

import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";

/**
 * One jurisdiction-scoped business-rule read, and only for a PPP animal.
 *
 * Deliberately tighter than the detail's own budget: this is a single indexed
 * lookup with a fallback, and it must never be the reason an owner cannot see
 * their pet.
 */
export const PPP_RULE_BUDGET_MS = 2_000;

/** The rule resolver, injectable so a test names the case instead of a Request. */
export type PppRuleResolver = (jurisdiction: {
  country: string;
  province: string | null;
  locality: string | null;
}) => Promise<{ payload: { registries: Array<{ id: string; label: string; required: boolean }> } }>;

const defaultResolver: PppRuleResolver = (jurisdiction) =>
  resolveBusinessRule("ppp_attestation_required_registries", jurisdiction);

/**
 * Resolve the section.
 *
 * THREE OUTCOMES, AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   · `data: null` — the animal is NOT under the PPP regime. The read is
 *     skipped entirely: asking the rules engine about a pet nobody classified
 *     as PPP would be one query per pet view to answer a question with no
 *     bearing on it.
 *   · `data: []` — the regime applies and this jurisdiction loaded no registry.
 *     A FACT, and the form acts on it by offering its national fallback.
 *   · `unavailable` — the read did not answer. NEVER flattened into the empty
 *     array above: a client that read "no registries" out of a failed lookup
 *     would print a national list as if a jurisdiction had chosen it.
 */
export async function resolvePppRegistries(
  pet: {
    potentiallyDangerousBreed: boolean | null;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
  },
  resolver: PppRuleResolver = defaultResolver,
): Promise<CredentialSection<OwnerPetPppRegistriesSection>> {
  if (!pet.potentiallyDangerousBreed) return { status: "ok", data: null };

  try {
    const resolved = await withDbBudgetOrThrow(
      resolver({
        country: "AR",
        province: pet.jurisdictionProvince,
        locality: pet.jurisdictionLocality,
      }),
      PPP_RULE_BUDGET_MS,
      "api-v1-pet-detail-ppp-rule",
    );
    // MAPPED FIELD BY FIELD rather than passed through. The rule's payload is a
    // domain shape that may grow columns an owner has no business reading; the
    // wire type is three fields and stays three.
    return {
      status: "ok",
      data: resolved.payload.registries.map((r) => ({
        id: r.id,
        label: r.label,
        required: r.required,
      })),
    };
  } catch (err) {
    // A BUDGET BLOWOUT DEGRADES THIS SECTION ALONE. The rest of the face is
    // already loaded and an owner looking at their pet must still see it.
    if (err instanceof DbBudgetExceededError) return { status: "unavailable" };
    throw err;
  }
}
