// Fills the landing carnet's slot tree from Pampa's seed + the hero's play
// state. Motion (tilt, flick, edges) stays on LandingHero — this file is WHAT
// the painter draws, not HOW it moves.

import {
  type CredentialDocumentSlotsV1,
  type CredentialSituationKey,
  emptyCredentialDocumentSlots,
  layoutVersionSupported,
  mayAnnounceSituation,
} from "@dim/contract/credential";

import {
  HERO_CREDENTIAL_FIELDS,
  HERO_LIBRETA_ROWS,
  HERO_MASKED_TOKEN,
  PAMPA,
  heroMrzLines,
} from "./landing-content";

export function landingHeroSituationKey(heroKey: string): CredentialSituationKey {
  if (heroKey === "perdida") return "perdida";
  if (heroKey === "observacion") return "observacion-antirrabica";
  if (heroKey === "tratamiento") return "en-tratamiento";
  return "al-dia";
}

export function buildLandingCarnetSlots(opts: {
  face: "front" | "back";
  publicToken: string | null;
  publicHref: string | null;
  heroStateKey: string;
  contextWord: string;
  contextRow: string;
}): CredentialDocumentSlotsV1 {
  const surface = "landing" as const;
  const base = emptyCredentialDocumentSlots(surface);
  if (!layoutVersionSupported(base.layoutVersion)) {
    return base;
  }
  const situationKey = landingHeroSituationKey(opts.heroStateKey);
  const announce = mayAnnounceSituation(surface, situationKey);
  return {
    ...base,
    face: opts.face === "back" ? "libreta" : "credencial",
    identity: {
      name: PAMPA.name,
      publicToken: opts.publicToken ?? HERO_MASKED_TOKEN,
      photoUrl: "/landing/pampa-hero.jpg",
      qrUrl: opts.publicHref,
      breedLine: null,
      registrationBadge: null,
    },
    fields: HERO_CREDENTIAL_FIELDS,
    contextLine: { stateWord: opts.contextWord, row: opts.contextRow },
    mrz: heroMrzLines(opts.publicToken),
    situation: announce
      ? {
          key: situationKey,
          tone: "",
          icon: "",
          label: opts.contextWord,
        }
      : null,
    back: {
      rows: HERO_LIBRETA_ROWS.map((row) => ({
        what: row.what,
        who: row.who,
        stamp: "FIRMADA",
      })),
    },
  };
}
