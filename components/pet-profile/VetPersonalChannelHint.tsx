// "This will be recorded as YOUR declaration, not as a professional record."
// T4-I1 / issue #757.
//
// WHAT SURPRISED SOMEBODY, AND WHY THE ANSWER IS A HINT AND NOT A FIX
// ---------------------------------------------------------------------------
// A vet with a validated matrícula records a vaccination on a dog they
// personally foster, and the event comes out attributed to the OWNER —
// `author_role='owner'`, `author_verified=false`, rendered "DECLARADA · SIN
// VERIFICAR". Verified in live QA (2026-07-02) as working-as-designed, and it
// is worth restating why, because "the system did not recognise my matrícula"
// is the obvious wrong reading:
//
//   `requirePetAccess` attributes by ACCESS PATH, not by profile role. The
//   person reached this animal through their own ownership row, so they are
//   acting as its holder. The H1 provenance model routes verified events
//   through the professional/institutional channel on purpose, and that is
//   also what keeps a vet from verifying their own animal's care — the
//   conflict of interest a registry exists to prevent.
//
// So the attribution is right and the SURPRISE is the defect. This component is
// the repair: say the thing before the person submits, in the place they would
// otherwise discover it afterwards, and name the door that does what they
// wanted.
//
// WHY IT ASKS FOR `accessPath` RATHER THAN ASSUMING IT
// ---------------------------------------------------------------------------
// Every page that renders this today reaches its pet through
// `requireOwnedPetByToken`, which is person-path by construction, so the
// parameter is always `"owner"` and the check always passes. It is a parameter
// anyway because the day one of these forms is reused behind an org door, a
// hint telling an organisation's vet that their signed record is a mere
// declaration would be actively false — and the failure would be silent. The
// condition the copy claims is the condition the component tests.
//
// A server component: it asks the database one indexed question about the
// acting user and renders nothing the client needs to hydrate.

import { eq } from "drizzle-orm";

import { LnCallout } from "@/components/ui/DocElements";
import { db, profiles } from "@/db";
import type { PetAccessPath } from "@/lib/infra/pet-access";

/**
 * The capture routes under `/mis-mascotas/{token}/eventos/nuevo/` that MUST
 * render this hint, as route slugs.
 *
 * A DECLARED LIST WITH A TEST BEHIND IT, not a convention: the failure mode
 * this component exists to prevent is a person discovering the attribution
 * after the fact, and "the author of the next clinical form forgot the hint"
 * reproduces it exactly. __tests__/vet-personal-channel-hint.test.ts reads this
 * array and asserts each page's source renders the component, so a new slug
 * added here fails until it is wired, and a page that drops the hint fails too.
 *
 * WHY THESE SIX AND NOT EVERY FORM. The hint is about PROVENANCE, so it earns
 * its space only where provenance changes what a surface says. These are the
 * events whose author decides a compliance card or a credential line:
 * vaccination, deworming, sterilization and microchip feed
 * lib/projections/pet-compliance.ts directly; the two clinical-record forms are
 * the ones a vet reaches for by habit. The rest are deliberately out — a note,
 * a weight, a tattoo and a post-adoption check-in are the holder's account of
 * their own animal whoever writes them, and a banner about matrículas there is
 * noise that would teach people to stop reading this one.
 *
 * `fallecimiento` and `mordedura` are the two judgment calls, both left OUT:
 * each already carries its own heavier copy about what it triggers, and adding
 * a provenance banner above a death record or a bite report buries the sentence
 * that actually matters on those pages.
 */
export const VET_HINT_CAPTURE_SLUGS = [
  "vacuna",
  "antiparasitario",
  "esterilizacion",
  "microchip",
  "clinico",
  "vet",
] as const;

type Props = {
  userId: string;
  /** The path this page's guard authorized by. The hint is person-path only. */
  accessPath: PetAccessPath | null;
};

export async function VetPersonalChannelHint({ userId, accessPath }: Props) {
  if (accessPath !== "owner") return null;

  // `matriculaVerified` and NOT the profile's account type: the whole point of
  // the #43/#45 provenance work is that the matrícula is what confers the
  // professional tier, and an account that merely CALLS itself a vet has never
  // been enough anywhere else (lib/infra/signer-provenance.ts says so at
  // length). Asking a different question here would make the hint appear for
  // people whose org channel would not sign their events either.
  const [profile] = await db
    .select({ matriculaVerified: profiles.matriculaVerified })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (profile?.matriculaVerified !== true) return null;

  // "UNA organización" AND NOT "TU organización", deliberately. The condition
  // this component tests is a validated matrícula, which is a property of the
  // PERSON; belonging to an organization in DIM is a separate fact it does not
  // check. A matriculated vet with no membership would have read "el canal de
  // tu organización" as a door they simply had not found yet, and gone looking
  // for it. This names what the professional channel IS without asserting the
  // reader already has one.
  return (
    <LnCallout tone="azul" title="Se registra como declaración del tenedor" className="mb-5">
      Estás entrando como tenedor/a de este animal, así que el evento queda asentado a tu nombre y
      sin verificación profesional. Para que lleve tu firma matriculada, el registro tiene que
      entrar por el canal profesional de una organización.
    </LnCallout>
  );
}
