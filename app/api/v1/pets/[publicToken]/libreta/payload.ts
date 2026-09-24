// The projection from the libreta face's domain read onto its wire shape.
//
// It lives beside the route for the reason the owner face's `payload.ts` gives:
// the reader answers "what is in this animal's ledger", and this answers "what
// may a client hold, and in what form". The web page consumes the same reader
// and none of this, which is the proof they are separable.
//
// WHAT THIS DELIBERATELY DROPS, and why each one is a decision rather than an
// oversight:
//
//   · `activeShares` — the libreta share tokens. Minting and revoking a shared
//     link is its own surface with its own audience (a vet who holds a link is
//     not this caller), and putting the live tokens on the owner's read would
//     put a working credential to somebody ELSE's view of the animal inside a
//     payload a device caches. The shared-link read is a different endpoint and
//     is out of scope for this one.
//   · `weightSamples` — the trailing-12-month curve behind a weight asiento's
//     sparkline. The asiento's own title already carries the value; the series
//     exists to draw a line this client does not draw.
//   · `identity.microchipId` / `tattooCode` — read by the loader for the export
//     path. The web's libreta masthead prints the name, the token and the
//     species line, and so does this.
//   · The emergency contact block — the VIEWER's own vet and emergency phone
//     numbers, resolved outside this reader and passed to the face as a prop.
//     The owner face made the same call about `viewerContacts`: a payload a
//     device holds carries facts about the ANIMAL.
//   · Every per-row href the future ledger carries. A `/mis-mascotas/...` URL
//     is a web address, not a fact.
//   · Every attachment URL — see the contract header. A timeline reports that a
//     file EXISTS; the event detail endpoint is where one is handed over, with
//     an expiry attached.

import { toAsientoView } from "@/components/pet-profile/asiento-fields";
import { pastEventMatchesAudience } from "@/components/pet-profile/libreta-lens";
import { amendAuthorshipRefusal, canAmendEvent } from "@/lib/infra/amendment";
import { apiV1Envelope } from "@/lib/infra/api-v1";
import type { LibretaFaceData } from "@/src/modules/pets/application/tab-data/types";
import type {
  LibretaEntryV1,
  LibretaFactV1,
  LibretaIdentitySection,
  LibretaTimelineSection,
  LibretaUpcomingSection,
  LibretaVaccinationSection,
  LibretaViewer,
  PetLibretaV1,
} from "@dim/contract/api";
import { PET_LIBRETA_PAYLOAD_VERSION, PET_LIBRETA_STALE_AFTER_MS } from "@dim/contract/api";

import { toViewerRole } from "../payload";

/**
 * WHO MAY CORRECT A RECORD, as one boolean.
 *
 * Mirrors the web event-detail page's `canAmend = accessPath === "owner"` — the
 * affordance, which is narrower than `amendEventAction`'s own guard. See the
 * contract's `LibretaViewer` docblock for why the two differ and why this
 * payload reports the narrower one.
 *
 * The DECEASED clamp is this surface's own addition and it is not a divergence
 * from the web's RULE, only from its BUTTON: `requireAlivePetAccess` refuses
 * every new event on a deceased animal, so the web renders a control that is
 * always refused. A control that cannot do anything is a lie with the shape of
 * a control, and a native client would have no error page to land the refusal
 * on.
 */
export function viewerCanAmend(input: { accessPath: "owner" | "org"; petStatus: string }): boolean {
  return input.accessPath === "owner" && input.petStatus !== "deceased";
}

/** An `AsientoFact`'s optional flags, normalised — absent and false are the same thing on a wire. */
function toFact(fact: {
  key: string;
  value: string;
  missing?: boolean;
  mono?: boolean;
}): LibretaFactV1 {
  return {
    key: fact.key,
    value: fact.value,
    missing: fact.missing ?? false,
    mono: fact.mono ?? false,
  };
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export type BuildPetLibretaInput = {
  publicToken: string;
  petStatus: string;
  accessPath: "owner" | "org";
  holderRole: string | null;
  data: LibretaFaceData;
  now: Date;
};

export function buildPetLibretaV1(input: BuildPetLibretaInput): PetLibretaV1 {
  const { data, now } = input;
  const canAmend = viewerCanAmend(input);

  const identity: LibretaIdentitySection = {
    name: data.identity.name,
    species: data.identity.species,
    // The contract types sex as the shared `PetSex` vocabulary; a row carrying
    // anything else reports null rather than widening the union.
    sex: data.identity.sex === "male" || data.identity.sex === "female" ? data.identity.sex : null,
    publicToken: data.identity.publicToken,
  };

  const vaccination: LibretaVaccinationSection = {
    active: data.summary.active,
    dueSoon: data.summary.dueSoon,
    expired: data.summary.expired,
    missing: data.summary.missing,
    unconfirmed: data.summary.unconfirmed,
    otherCount: data.summary.otherCount,
    perVaccine: data.summary.perVaccine.map((v) => ({
      vaccineName: v.vaccineName,
      status: v.status,
      lastDoseAt: toIsoOrNull(v.lastDoseAt),
      nextDueAt: toIsoOrNull(v.nextDueAt),
    })),
  };

  const upcoming: LibretaUpcomingSection = {
    items: data.future.map((item) => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      dueAt: item.dueAt.toISOString(),
      reminderId: item.reminderId ?? null,
    })),
  };

  // THE AUDIENCE FILTER IS THE WEB'S, applied server-side here rather than in
  // the client that renders it. `LibretaFace` filters with the same predicate
  // from the same module: an owner sees the whole consolidated timeline, an
  // org/vet viewer sees only the libreta-sanitaria whitelist. Doing it on this
  // side means an org viewer's device never RECEIVES the rows it may not read,
  // which a client-side filter cannot promise.
  const audience = input.accessPath === "owner" ? "owner" : "org";
  const visible = data.past.filter((row) => pastEventMatchesAudience(row.eventType, audience));

  const entries: LibretaEntryV1[] = visible.map((row) => {
    // The SAME projection the web renders — the per-type whitelisted templates,
    // the provenance tier, the AR-calendar date labels. Reused rather than
    // reimplemented because it carries the H3 privacy whitelist inside it: a
    // second projection would be a second place for a hash or an internal id to
    // reach a citizen surface.
    const view = toAsientoView(row, input.publicToken, data.viewer, now);
    return {
      eventId: row.id,
      eventType: row.eventType,
      kind: view.kind,
      title: view.title,
      occurredAt: new Date(row.occurredAt).toISOString(),
      whenRelative: view.whenRelative,
      whenAbsolute: view.whenAbsolute,
      facts: view.facts.map(toFact),
      note: view.handwrittenNote ?? null,
      provenance: { verified: view.provenance.verified, label: view.provenance.label },
      warning: view.warn ?? null,
      amendedAt: toIsoOrNull(row.amendedAt ?? null),
      hasAttachment: row.hasAttachment,
      // The allowlist AND the viewer's capability, folded into one boolean so a
      // client cannot get the conjunction subtly wrong — the same function the
      // web's "Corregir registro" button gates on. Plus the authorship rule (PO
      // decision 3B) on the ROW's own author: an owner is offered only what
      // they wrote. The correction chain's authors are not in this read, so a
      // row of theirs that a professional later corrected can still say true
      // here; the event detail (`amend.canAmend`, which reads the chain) and
      // the write itself both refuse it. The actor's ownership history is not
      // read either, so a LEGACY row with no recorded author says false here
      // (under-offered, never over-offered); the event detail answers it
      // exactly.
      canAmend:
        canAmendEvent({ eventType: row.eventType, viewerCanWriteEvents: canAmend }) &&
        amendAuthorshipRefusal(
          {
            userId: data.viewer.userId,
            standing: "person",
            titularTenures: [],
          },
          [
            {
              authorRole: row.authorRole,
              authorVerified: row.authorVerified,
              recordedByUserId: row.recordedByUserId,
            },
          ],
        ) === null,
    };
  });

  const timeline: LibretaTimelineSection = {
    entries,
    total: entries.length,
    // The reader's own probe row decided this, against the UNFILTERED window.
    // It answers "are there older asientos than these", which is what the web's
    // "Mostrando los eventos más recientes" note says — not "did the audience
    // filter remove rows", which is a different sentence nobody should print.
    truncated: data.pastTruncated,
  };

  const viewer: LibretaViewer = {
    role: toViewerRole(input.accessPath, input.holderRole),
    // TITULAR means the legal owner and nothing else — the same test the owner
    // face applies, so the two faces of one pet cannot disagree about who is
    // reading them.
    isTitular: input.accessPath === "owner" && input.holderRole === "owner",
    canAmend,
  };

  return {
    ...apiV1Envelope({
      payloadVersion: PET_LIBRETA_PAYLOAD_VERSION,
      issuedAt: now,
      staleAfterMs: PET_LIBRETA_STALE_AFTER_MS,
    }),
    publicToken: input.publicToken,
    viewer,
    identity: { status: "ok", data: identity },
    vaccination: { status: "ok", data: vaccination },
    upcoming: { status: "ok", data: upcoming },
    timeline: { status: "ok", data: timeline },
  };
}
