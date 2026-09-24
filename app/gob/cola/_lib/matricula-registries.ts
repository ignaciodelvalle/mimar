// Matrícula consultation registry — per-jurisdiction lookup pages for the vet
// license verification flow (UI/UX audit 2026-07: approval must be a
// verification, not a rubber stamp).
//
// PURE module — no DB, no Next.js.
//
// HONESTY NOTE: the repo's reference data (lib/reference/*) holds NO
// authoritative, machine-consumable registry of veterinary matrículas — vet
// licensing in Argentina is per-jurisdiction (provincial colegios/consejos
// profesionales; SENASA registers establishments and accredited vets for
// sanitary programs, it does NOT issue matrículas). Every entry below is
// therefore a DOCUMENTED public search/landing page of the jurisdiction's
// professional college, and every one is flagged `consultaManual: true` — the
// operator opens it and searches by name/number by hand. There is no
// authoritative deep-link API to hide that behind, and pretending otherwise
// would fabricate a verification the page cannot perform.
//
// Matching: `matricula_jurisdiccion` is free text captured from the applicant
// (lib/infra/approval-payloads.ts — z.string().min(2).max(60)), so entries are
// matched on a normalized (lowercase, accent-stripped) form with the common
// aliases each jurisdiction is typed as.

export type MatriculaRegistryLink = {
  /** Display name of the registry/college (es-AR). */
  label: string;
  /** Public search or landing page of the professional college. */
  url: string;
  /** Always true today — see HONESTY NOTE. Rendered as a "consulta manual" tag. */
  consultaManual: true;
};

/** Normalize a free-text jurisdiction for matching: lowercase, accent-stripped,
 * collapsed whitespace. Same rule family as percapita.normalizeProvinceName. */
export function normalizeJurisdictionName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
}

type RegistryEntry = MatriculaRegistryLink & { aliases: string[] };

// Only jurisdictions with a STABLE, well-known college web presence are listed.
// Anything unlisted degrades to the manual-consultation fallback copy (the
// caller renders "sin registro en línea conocido") — never a guessed URL.
const REGISTRY_ENTRIES: RegistryEntry[] = [
  {
    label: "Colegio de Veterinarios de la Provincia de Buenos Aires (CVPBA)",
    url: "https://cvpba.org/",
    consultaManual: true,
    aliases: ["buenos aires", "provincia de buenos aires", "pba", "bs as", "bsas"],
  },
  {
    label: "Consejo Profesional de Médicos Veterinarios (CABA)",
    url: "https://cpmv.org.ar/",
    consultaManual: true,
    aliases: [
      "caba",
      "capital federal",
      "ciudad autonoma de buenos aires",
      "ciudad de buenos aires",
    ],
  },
];

/**
 * Resolve the consultation link for an applicant-declared matrícula
 * jurisdiction. Returns null when the jurisdiction is unknown/unlisted — the
 * caller must render the honest manual-consultation fallback, never a guess.
 */
export function matriculaRegistryFor(
  declaredJurisdiction: string | null | undefined,
): MatriculaRegistryLink | null {
  if (!declaredJurisdiction) return null;
  const norm = normalizeJurisdictionName(declaredJurisdiction);
  if (!norm) return null;
  for (const entry of REGISTRY_ENTRIES) {
    if (entry.aliases.includes(norm)) {
      return { label: entry.label, url: entry.url, consultaManual: entry.consultaManual };
    }
  }
  return null;
}
