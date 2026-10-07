// The legal-document versions a signup can accept — shared by the web and the
// native app, because each of them DISPLAYS a consent sentence and each must be
// able to say which one it displayed.
//
// Ley 25.326 art. 5 requires consent to be informed, express AND PROVABLE: to
// show WHAT somebody agreed to, `profiles.tos_version` records the version of
// the Terms + Privacy Policy whose sentence they ticked. One shared string
// covers both documents; they change together (same "Última actualización").
// Format: ISO date of the last substantive revision.
//
// WHY THIS LIVES IN THE CONTRACT (review of 1c1ac9f82, 2026-09-24). The server
// used to stamp its OWN current version on every acceptance. That is only true
// for a client that renders what the server renders. The Android app ships its
// consent sentence inside a bundle, and an old bundle keeps showing the old
// sentence after the server moves on — so the server was recording, for those
// people, a text they never saw. Now the client SENDS the version it displayed
// (`legalVersion` on the signup body), and the server records it only if it is
// one of `KNOWN_LEGAL_VERSIONS`. A client that sends nothing is, by definition,
// a client built before it knew to — it showed `PREVIOUS_LEGAL_VERSION`.
//
// Bumping: add the new date to `KNOWN_LEGAL_VERSIONS`, move `LEGAL_VERSION`,
// and set `PREVIOUS_LEGAL_VERSION` to the version bundles WITHOUT a
// `legalVersion` field displayed — which stays "2026-07-23" forever, because
// every bundle from 2026-09-24 onward sends the field.
//
// BUMPING RE-ASKS EVERY PERSONAL ACCOUNT (2026-10-07). Since this version a
// personal account whose recorded `tos_version` is not `LEGAL_VERSION` is sent
// to the re-acceptance screen (`isLegalAcceptancePending`,
// lib/domain/legal-acceptance.ts) before it can use the owner portal or the app.
// That is the point — Disp. 377/2026 inc. b makes a unilateral change by mere
// notice abusive, so a substantive change needs a new acceptance — and it is
// also the cost: bump only for a substantive change, never for a typo.
//
// WHAT A VERSION PROVES. From 2026-10-07 on, a recorded version means the
// person ticked THREE separate boxes, each required by the server: the Terms
// and Privacy Policy; the international transfer, naming Brasil and Estados
// Unidos (Ley 25.326 art. 12; Dec. 1558/2001 art. 5 inc. 1 asks for it to be
// "expresa y destacada" when it is given beside other declarations — legal
// review P10); and the 18+ age declaration (review P9). The pair
// (`tos_accepted_at`, `tos_version`) is the latest acceptance; a re-acceptance
// replaces it and the previous pair is kept in the `audit_log` row the
// re-acceptance writes.
//
// HISTORY
//   2026-07-23 — first recorded version.
//   2026-09-24 — /privacidad names every provider that processes data, with its
//                country, and discloses the international transfer (Brazil,
//                US) under Ley 25.326 art. 12; the signup sentence consents to
//                that transfer by name (finding S-2, PO decision 6A).
//   2026-10-07 — CONSERVATIVE INTERIM (PO decision D2 = b, legal review
//                2026-10-02, rows P9-P11; counsel may loosen it later). The
//                transfer consent becomes its own box naming the countries;
//                an 18+ declaration is required; /terminos drops the
//                acceptance-by-use sentence, the indirect-damages exclusion
//                and the update-by-email clause (Ley 24.240 art. 37 a;
//                Disp. 377/2026 incs. b, g, p).

/** Every version a consent may be recorded under, oldest first. */
export const KNOWN_LEGAL_VERSIONS = ["2026-07-23", "2026-09-24", "2026-10-07"] as const;

export type LegalVersion = (typeof KNOWN_LEGAL_VERSIONS)[number];

/** The version the current consent sentences and legal pages carry. */
export const LEGAL_VERSION: LegalVersion = "2026-10-07";

/** Human-facing label for the legal pages. Bumped together with the version. */
export const LEGAL_VERSION_LABEL = "octubre 2026";

/**
 * The international-transfer consent sentence, shared by the web form, the
 * re-acceptance screen and the app so the three cannot name different
 * countries. The countries are the ones /privacidad#proveedores lists for the
 * providers outside an adequate country: Supabase and Vercel's servers in
 * Brasil; Vercel Inc., Sentry, Expo, Google FCM and Resend in Estados Unidos.
 * (OpenStreetMap is in the Reino Unido, which IS on the adequacy list, so it
 * needs no consent and is not named.) Change the providers, change this.
 */
export const TRANSFER_CONSENT_SENTENCE =
  "Acepto que mis datos se transfieran a proveedores en Brasil y en Estados Unidos, países que no figuran en la lista argentina de países con protección adecuada de datos personales.";

/**
 * The art. 6 notice shown NEXT TO the transfer box (Ley 25.326 art. 6; legal
 * review T3-1: the consent must be "expresa y destacada" AND preceded by the
 * art. 6 information), one paragraph per element: purpose and recipients;
 * withdrawal and what survives it; rights; the controller; the AAIP legend.
 *
 * REUSED, NOT WRITTEN FRESH (security review of textos-legales-v14, finding 5):
 *   · the recipients are /privacidad#proveedores's list, including the browser
 *     push services (Google, Mozilla or Apple);
 *   · what survives an account deletion is /privacidad's "Qué pasa cuando se
 *     elimina una cuenta" — sanitary events stay as the animal's history. It is
 *     NOT presented as a legal obligation to conserve, because /privacidad
 *     deliberately does not claim one (see the ERRATA in
 *     src/modules/auth/application/subject-rights/erase-subject-data.ts);
 *   · the controller and address are /privacidad#responsable's;
 *   · the AAIP legend is Res. AAIP 14/2018 art. 3, verbatim, as /privacidad
 *     prints it.
 * Change /privacidad, change this.
 */
export const TRANSFER_CONSENT_NOTICE: readonly string[] = [
  "Para qué y a quiénes: para guardar tu cuenta y los datos de tus mascotas, enviarte correos y avisos y registrar fallas de la app, tus datos pasan por Supabase y Vercel (servidores en Brasil) y por Vercel, Sentry, Expo, Google (Firebase) y Resend, y —si activás los avisos del sitio— por el servicio de notificaciones de tu navegador (Google, Mozilla o Apple), en Estados Unidos.",
  "Podés retirar este consentimiento cuando quieras eliminando tu cuenta desde Mi cuenta → Privacidad. Los eventos sanitarios de tus mascotas no se borran: son el historial de salud del animal y muchos los registró otra persona; el texto libre que escribiste en ellos se reemplaza por un aviso.",
  "Tenés derecho a acceder a tus datos, rectificarlos, actualizarlos y suprimirlos (Ley 25.326, art. 14).",
  "Responsable de los datos: Ignacio Del Valle, Av. Raúl Scalabrini Ortiz 1270, Ciudad Autónoma de Buenos Aires.",
  "LA AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales.",
];

/**
 * What changed in each version, in plain es-AR, for the re-acceptance screens
 * (web /aceptar-condiciones and the app's twin). GENERAL CIRCUIT (legal report
 * 2026-10, §3.1 row 5, F-9 closed): a substantive change needs a POSITIVE act
 * of acceptance — silence is not acceptance (CCyC art. 979; Disp. 377/2026
 * incs. b and p) — so whenever `LEGAL_VERSION` moves, every personal account
 * on an older version is shown what changed and accepts again. Adding a
 * version means adding its entry here: the `Record` makes a missing one a
 * compile error. The transfer consent is versioned by the same string — one
 * acceptance records the Terms, the Policy and the transfer together, each in
 * its own box.
 */
export const LEGAL_VERSION_CHANGES: Readonly<Record<LegalVersion, readonly string[]>> = {
  "2026-07-23": ["Primera versión de los términos y la política de privacidad."],
  "2026-09-24": [
    "La política de privacidad nombra a cada proveedor que procesa tus datos y en qué país está.",
  ],
  "2026-10-07": [
    "Te pedimos por separado que aceptes la transferencia de tus datos a proveedores en Brasil y Estados Unidos.",
    "Te pedimos que confirmes que tenés 18 años o más.",
    "Sacamos de los términos tres cláusulas: la que decía que usar el servicio implicaba aceptarlos, la que excluía nuestra responsabilidad por daños indirectos y la que nos permitía cambiarlos con solo avisarte por correo.",
    "Si cambiamos los términos en algo importante, te vamos a pedir que los aceptes de nuevo, como ahora.",
  ],
};

/**
 * The changes a person has not accepted yet: every version after the one they
 * accepted, oldest first. A version this build does not know (or none) shows
 * only the current version's changes — never an empty list, because the screen
 * that calls this exists to say what changed.
 */
export function legalChangesSince(accepted: string | null | undefined): string[] {
  const index = (KNOWN_LEGAL_VERSIONS as readonly string[]).indexOf(accepted ?? "");
  const pending = index === -1 ? [LEGAL_VERSION] : KNOWN_LEGAL_VERSIONS.slice(index + 1);
  const changes = pending.flatMap((v) => LEGAL_VERSION_CHANGES[v]);
  return changes.length > 0 ? changes : [...LEGAL_VERSION_CHANGES[LEGAL_VERSION]];
}

/**
 * The age declaration. CONSERVATIVE INTERIM (legal review 2026-10-02, row P9):
 * there is no fixed age in Argentine law — CCyC art. 26 (progressive autonomy)
 * and Res. AAIP 4/2019, Criterio 5 — and the review's minimum measure is a
 * declaration at signup. 18 is the most conservative threshold; counsel will
 * fix the real one (13, 16 or 18) and whether parents can consent below it.
 */
export const ADULT_DECLARATION_SENTENCE = "Tengo 18 años o más.";

/**
 * What a client that sends NO version displayed: every signup surface built
 * before `legalVersion` existed showed the 2026-07-23 sentence.
 */
export const PREVIOUS_LEGAL_VERSION: LegalVersion = "2026-07-23";

/**
 * The version to RECORD for what a client claims it displayed. A known version
 * is taken as sent; anything else — absent, empty, malformed, or a date this
 * build does not know — falls back to `PREVIOUS_LEGAL_VERSION`. The fallback
 * is the conservative one on purpose: under-claiming what somebody consented
 * to is a gap that can be closed by asking again; over-claiming is a record
 * that asserts a consent that was never given.
 */
export function resolveAcceptedLegalVersion(sent: unknown): LegalVersion {
  return typeof sent === "string" && (KNOWN_LEGAL_VERSIONS as readonly string[]).includes(sent)
    ? (sent as LegalVersion)
    : PREVIOUS_LEGAL_VERSION;
}
