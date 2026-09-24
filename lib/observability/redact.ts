// Redaction layer for client-side error reports (task #56b).
//
// WHY THIS EXISTS, AND WHY IT IS NOT OPTIONAL
// ---------------------------------------------------------------------------
// The moment `lib/observability/report-error.ts` forwards anything to a third
// party, every string in the report leaves Argentina's jurisdiction and lands
// in someone else's database. A stack trace is NOT obviously PII-free: it
// carries function arguments, the URL of the page (path segments AND query
// string), and whatever a thrown `Error` chose to interpolate into its message.
// This repo handles citizen DNIs, home addresses, phone numbers and pet health
// data bound to named people, so the checklist in AGENTS.md
// (§ Privacidad y manejo de datos) applies to the telemetry path exactly as it
// applies to a public route:
//
//   - Rule 1, "No DNI in plaintext" — migration 0106 dropped
//     `profiles.dni_number` so the DNI cannot be read from the database. A DNI
//     interpolated into an error message would reintroduce, in a third-party
//     SaaS, precisely the cleartext the schema refuses to hold.
//   - Rule 3, "Never return raw event payloads" — the same reasoning applies to
//     a raw context blob: project the fields you need, never ship the bag.
//   - Rule 4, "Privacy predicates in the query, not the render layer" — the
//     structural analogue here is that redaction happens in this module, once,
//     before the sink is handed anything. Not at each call site, and never
//     inside a provider's SDK config.
//
// THE TWO MECHANISMS, AND WHY THERE ARE TWO
// ---------------------------------------------------------------------------
// Free text (`message`, `stack`) cannot be allowlisted — it is authored by
// whatever threw. So it gets a *scrubber*: a denylist of PII shapes, applied
// fail-closed.
//
// Structured context is caller-supplied and CAN be allowlisted, so it is:
// `report-error.ts` keeps a closed set of keys. Keys are allowlisted
// (structure), values are still scrubbed (content). Both, because either alone
// leaks: an allowlisted `homeHref` really does carry a live capability token
// today (`app/org/[orgToken]/error.tsx` passes `/org/${orgToken}`), and a
// scrubber alone would let any new call site attach a whole user object.
//
// FAIL-CLOSED IS A DELIBERATE TRADE
// ---------------------------------------------------------------------------
// A run of 7+ digits is redacted. That covers the Argentine DNI space (7–8
// digits) and bare phone numbers (10), and it also eats epoch-millisecond
// timestamps and very large line offsets that happen to appear in a stack. That
// collateral is accepted on purpose: the cost of a false positive is a less
// readable log line, and the cost of a false negative is a citizen's DNI in a
// vendor's index. Those are not comparable, so the rule does not try to be
// clever about telling them apart.

/**
 * Credential-code namespace prefixes, hyphen INCLUDED.
 *
 * WHY THE HYPHEN IS PART OF THE VALUE, and not glued on when the regex is
 * built: a prefix here is a *namespace*, and the hyphen is what makes it one.
 * `scripts/check-brand-casing.ts` Rule 2 draws exactly that distinction — bare
 * `DIM` is the internal codename leaking into something a user reads, while
 * `DIM-` is a public credential token and is never flagged. Writing the values
 * in their true form is what keeps this list truthful AND keeps `lint:brand`
 * green, with no `dim-codename-ok` pragma. A pragma here would have been the
 * wrong instrument twice over: it would freeze a list we already knew was
 * incomplete, and it would silence the one fence that noticed.
 *
 * RECOUNTED AT THE SOURCE on 2026-08-29, not transcribed from a header. The
 * header of `lib/infra/publicToken.ts` lists seven prefixes and is itself
 * stale: four more (`CAS`, `DIS`, `PTR`, `FP`) are minted by call sites in
 * `src/modules/**` that pass their own literal to `generatePrefixedToken`,
 * which takes a plain `string` and therefore constrains nobody. `DEN` comes
 * from a second, unrelated generator entirely
 * (`src/modules/welfare/domain/reference-code.ts`, its own alphabet). Twelve
 * in total. The previous version of this rule covered three.
 *
 * WHY THIS IS A LIST PLUS A FENCE, AND NOT AN IMPORT. Importing the prefixes
 * from `lib/infra/publicToken.ts` would be the obvious derivation, and it is
 * not available: that module imports `node:crypto`, and this one is bundled
 * into the BROWSER. So the list is local, and `redact-prefix-coverage.test.ts`
 * re-derives the true set from the repo on every run and fails when the two
 * disagree. A transcribed list goes stale in silence; a transcribed list with
 * a fence in front of it goes stale loudly, which is the property that matters.
 */
export const CREDENTIAL_TOKEN_PREFIXES: readonly string[] = [
  "DIM-", // pet credential public token, and organizations.public_token
  "LBR-", // libreta share token — the link handed to a vet or a walker
  "APR-", // approval request (org upgrade, service-dog verification)
  "OFR-", // service offering
  "APT-", // appointment
  "INV-", // organization invitation — accepting it grants membership
  "TAG-", // physical tag serial
  "CAS-", // case
  "DIS-", // custody dispute
  "PTR-", // pet transfer
  "FP-", // foster proposal (two letters, not three — a `[A-Z]{3}` rule misses it)
  "DEN-", // welfare denuncia reference code, from the welfare generator
];

/** Escapes a literal for embedding in a regex source string. */
function escapeForRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * Route segments whose NEXT path segment is an unguessable bearer string.
 *
 * Holding the string IS the authorization for these, so a leaked one is a live
 * grant rather than merely an identifier. Recounted from the router on
 * 2026-08-30 by enumerating every dynamic segment under `app/` and
 * `apps/mobile/app/` whose param carries a token, code or serial.
 *
 * **Do not hand-maintain this against the router — it will go stale, and it
 * has, twice.** `redact-prefix-coverage.test.ts` derives the same set from the
 * filesystem and names what is missing; adding the entry it names is the whole
 * fix. It found `/api/v1/pets/[publicToken]` on its first run, and on
 * 2026-08-30 it caught `adoptions` at an integration gate, on a route that had
 * merged an hour earlier. **The shape it keeps catching is an API twin**: a
 * capability first ships as a Spanish screen segment, the entry gets added, and
 * then `/api/v1/<english-plural>/` arrives later as a second URL carrying the
 * same token. `mascotas`/`pets` and `adoptar`/`adoptions` are both that pair.
 * If you are adding an `/api/v1` route whose next segment is a token, its
 * segment belongs here even when the screen it mirrors is already listed.
 *
 * Most of the values behind these segments are ALSO covered by the credential
 * rule above, because they are `PREFIX-XXXX-XXXX` codes. That redundancy is
 * deliberate: this rule is the one that still fires if a token format changes,
 * and it is the only rule that covers a shape nobody enumerated. `cuidado`
 * earns its place outright — a care grant is `CG-` + 32 hex, which no
 * credential-code rule matches.
 *
 * The trade is the same one the digit catch-all makes: `/casos/abierto` gets
 * redacted along with `/casos/CAS-A1B2-C3D4`, because the rule cannot tell a
 * status slug from a token without knowing every slug. A less readable log
 * line is the cheaper mistake.
 */
export const CAPABILITY_PATH_SEGMENTS: readonly string[] = [
  "p", // /p/[publicToken] — the public credential page
  "org", // /org/[orgToken] — the org portal
  "refugios", // /refugios/[orgToken]
  "compartir", // /libreta/compartir/[shareToken]
  "cuidado", // /cuidado/[grantToken] — CG- + 32 hex, prefix rules miss it
  "adoptar", // /adoptar/[petToken]
  "adoptions", // /api/v1/adoptions/[petToken] — the API twin of `adoptar`
  "mis-mascotas", // /mis-mascotas/[publicToken]
  "mascotas", // /gob|/admin|/org/.../mascotas/[token], and apps/mobile
  "pets", // /api/v1/pets/[publicToken] — the public API, same token
  "atender", // /org/[orgToken]/atender/[publicToken]
  "cola", // /gob|/admin/cola/[publicToken]
  "observaciones", // /gob|/admin/observaciones/[publicToken]
  "casos", // /casos|/gob/casos|/admin/casos/[publicCode]
  "decomisos", // /gob/decomisos/[publicCode]
  "disputas", // /gob/disputas/[disputeToken]
  "investigaciones", // /gob/vigilancia/investigaciones/[caseCode]
  "codigo", // /denuncias/codigo/[code] — an anonymous reporter's ONLY key
  "transferencias", // /transferencias/[transferToken]
  "propuestas", // /cuenta/transitos/propuestas/[proposalToken]
  "servicios", // /gob|/admin|/org/.../servicios/[offeringToken]
  "turnos", // /org/[orgToken]/agenda/turnos/[appointmentToken]
  "mis-turnos", // /mis-turnos/[appointmentToken]
  "buscar", // /turnos/buscar/[offeringToken]
  "appointments", // /api/v1/appointments/[offeringToken] — the API twin of `buscar`
  "invite", // /r/invite/[token] — accepting it grants org membership
  "match", // /mis-mascotas/nueva/match/[matchedPetToken]
  "nueva", // /mis-mascotas/nueva/[publicToken]
  "t", // /t/[serial] — physical tag serial
];

/**
 * Applied in order; earlier, more specific rules win over later, broader ones.
 *
 * The ordering is LOAD-BEARING, not stylistic, and
 * `redact.test.ts` pins it with a case where the two orders give different
 * output: the broad digit catch-all would otherwise consume the digits inside
 * a separated phone number and leave `[redacted:digits]` where
 * `[redacted:phone]` belongs, destroying the one bit of signal a reader needs
 * to know what kind of value was there.
 */
const SCRUB_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Email addresses.
  {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: "[redacted:email]",
  },
  // Product credential codes, built from the recounted prefix list above so a
  // new prefix cannot be added to the product without also being redacted.
  {
    pattern: new RegExp(
      `\\b(?:${CREDENTIAL_TOKEN_PREFIXES.map(escapeForRegex).join("|")})[A-Z0-9]{4}-[A-Z0-9]{4}\\b`,
      "gi",
    ),
    replacement: "[redacted:credential]",
  },
  // Care-grant tokens: a namespace prefix plus 32 hex, minted by
  // `src/modules/caretakers/infrastructure/caretakers-repository.ts`. A
  // different shape from every other token in the product, so it needs its own
  // rule — the page it opens shows a pet's name, photo and the titular's
  // display name to an unauthenticated visitor holding the link.
  {
    pattern: /\bCG-[0-9a-f]{32}\b/gi,
    replacement: "[redacted:grant]",
  },
  // JWTs (Supabase access/refresh tokens are JWTs and DO reach the browser).
  // The signature segment is NOT optional in this pattern: matching only
  // `header.payload` would leave the signature trailing in cleartext, which is
  // the half that makes the token forgeable.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g,
    replacement: "[redacted:jwt]",
  },
  // An unsigned or malformed JWT — still a bearer-shaped blob, still not ours
  // to forward. Second rule rather than an optional group, so the signed case
  // above can never be satisfied by a prefix of itself.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    replacement: "[redacted:jwt]",
  },
  // `Authorization: Bearer …` / `Basic …` echoed into a fetch error message.
  {
    pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: "[redacted:authorization]",
  },
  // Capability tokens carried as a URL PATH segment.
  {
    pattern: new RegExp(
      `/(${CAPABILITY_PATH_SEGMENTS.map(escapeForRegex).join("|")})/[A-Za-z0-9_-]{6,}`,
      "gi",
    ),
    replacement: "/$1/[redacted:token]",
  },
  // Sensitive URL query/fragment parameters — value replaced, key kept so the
  // shape of the failing request is still legible.
  {
    pattern:
      /([?&#][A-Za-z0-9_-]*(?:token|secret|key|password|passwd|pass|auth|session|signature|sig|pepper|code)[A-Za-z0-9_-]*=)[^&#\s"'<>]*/gi,
    replacement: "$1[redacted]",
  },
  // Phone numbers written in international / separated form (+54 9 11 1234-5678).
  {
    pattern: /\+\d[\d\s().-]{7,17}\d/g,
    replacement: "[redacted:phone]",
  },
  // Phone numbers in LOCAL separated form: `11-1234-5678`, `011 4567-8901`,
  // `(0351) 456-7890`, `11 15 1234-5678`. No `+`, so the rule above misses it,
  // and the separators leave no run of 7+ digits for the catch-all below.
  // Precise on purpose — it encodes the Argentine numbering plan (area code
  // plus subscriber prefix total six digits: 2+4, 3+3 or 4+2, optional trunk
  // `0`, optional mobile `15`, then the four-digit line) so dates and ranges
  // survive. A bare `4567-8901` is left alone: two groups of four is also an
  // order number or a stack position. Same rule as the phone's twin
  // (`apps/mobile/src/observability/redact.ts`).
  {
    pattern:
      /(?<![\w.+-])(?:(?:\(0?\d{2}\)|0?\d{2})[\s-](?:15[\s-])?\d{4}|(?:\(0?\d{3}\)|0?\d{3})[\s-](?:15[\s-])?\d{3}|(?:\(0?\d{4}\)|0?\d{4})[\s-](?:15[\s-])?\d{2})[\s-]\d{4}(?!\w|-|\.\d)/g,
    replacement: "[redacted:phone]",
  },
  // A DNI written with dots (`12.345.678`, `1.234.567`) — three runs under the
  // catch-all's 7-digit floor. Anchored so a version, an IP or a dotted date
  // does not match. Accepted collateral, the catch-all's own trade: an es-AR
  // amount of a million or more (`$ 1.234.567`) is indistinguishable from a
  // DNI and goes too.
  {
    pattern: /(?<![\w.])\d{1,2}\.\d{3}\.\d{3}(?!\w|\.\d)/g,
    replacement: "[redacted:dni]",
  },
  // Fail-closed catch-all: any bare run of 7+ digits. Covers DNI (7–8) and bare
  // local phone numbers (10). See the header note on the accepted trade.
  {
    pattern: /(?<!\d)\d{7,}(?!\d)/g,
    replacement: "[redacted:digits]",
  },
];

/**
 * Scrubs PII-shaped substrings out of free text (an error message or stack).
 *
 * Order-dependent by construction: specific shapes are consumed before the
 * broad digit catch-all can fragment them.
 */
export function redactText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SCRUB_RULES) {
    // Each rule carries the /g flag; `replace` resets lastIndex for us because
    // we never call `.exec` on these shared instances.
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Scrubs a single context value. Only primitives survive: a string is scrubbed,
 * a finite number / boolean passes through, and anything else (object, array,
 * function, symbol) is dropped to `undefined`.
 *
 * Dropping objects is the point. An object cannot be scrubbed with confidence —
 * its keys are unknown, it may be a React synthetic event, a whole `profile`
 * row, or a `Response` — so the reporter refuses to guess.
 */
export function redactContextValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  return undefined;
}
