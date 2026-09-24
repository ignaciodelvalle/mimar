// What a client may SEND to `POST /api/v1/welfare-reports` — a citizen's
// denuncia of animal cruelty under Ley Nacional 14.346.
//
// THIS IS NOT "REPORTING CONTENT", AND THE DIFFERENCE IS THE WHOLE SHAPE
// ---------------------------------------------------------------------------
// A content report asks a platform to look at a post. This asks the STATE to
// look at a crime: Ley 14.346 (1954) carries prison for malos tratos and actos
// de crueldad, the submission opens a `welfare_denuncia` case routed to the
// authority of the jurisdiction the coordinates fall in, and it may end in an
// MPF export a fiscal reads. Nothing here is moderation and nothing here is
// reversible by the person who sent it: the case is a row on an append-only
// spine from the moment it lands.
//
// That is why this module is strict in places a feedback form would be loose —
// a 20-character floor on the description, mandatory coordinates, a closed
// vocabulary of nine kinds — and loose in the one place a moderation queue
// would be strict: it does not ask who is reporting.
//
// THE ANONYMOUS MEMBER HAS NO CONTACT FIELDS, AND THAT IS THE POINT
// ---------------------------------------------------------------------------
// `contactMode` is the DISCRIMINATOR, not a flag beside two optional strings.
// An anonymous denuncia is a shape with nowhere to put an e-mail address, so a
// client cannot send one "by accident" and a server cannot store one it was
// never handed. The mismatch is unrepresentable rather than rejected — the same
// instrument `pet-claim.ts` uses to keep a pet token out of a claim.
//
// The web reaches the same outcome by a weaker route and it is worth saying so
// where somebody comparing the two will read it: `Step5Contact.tsx` renders the
// two inputs only under `with_contact`, so an anonymous browser submission
// carries no contact because the fields are not in the DOM. That is a CLIENT
// guarantee. `createWelfareReportAction` reads `reporterContactEmail` out of the
// FormData regardless of `contactMode`, so a hand-rolled POST can pair
// `contactMode=anonymous` with an address and have it stored. Reported, not
// fixed here — it is the web's own intake — and this transport is built so the
// same request cannot be spelled.
//
// NO ATTACHMENTS, AND THE ABSENCE IS A BLOCK RATHER THAN A CHOICE
// ---------------------------------------------------------------------------
// Evidence goes to a private bucket through a signed upload, which needs a file
// picker, which is a native module, which is an EAS build — the same wall the
// pet photo, the art. 14 export and the claim DISPUTE ran into. So this schema
// has no `attachment` member of any kind, and adding one is a deliberate edit
// the day this app can carry bytes.
//
// DO NOT BUILD A PARALLEL UPLOAD PATH TO GET AROUND IT. This repo already
// carries two blanket storage grants that exist because somebody did exactly
// that once. And there is a second, sharper reason to keep photos off this door
// in particular: a phone photo carries the GPS EXIF of an anonymous reporter's
// home. The web door refuses HEIC/HEIF (PO decision D4, 2026-09-18) and strips
// JPEG/PNG/WebP failing closed (`lib/infra/welfare-uploads.ts`); video still
// carries its position until D4b. When this door takes bytes, it goes through
// that helper — never a second path beside it.
//
// WHAT IS ALSO NOT HERE: `dwellTimeMs` AND THE HONEYPOT
// ---------------------------------------------------------------------------
// `computeFlagReasons` reads two browser instruments — how long the form was on
// screen, and whether a hidden input got filled. Both measure a BROWSER, and a
// native client would have to invent numbers for them: a `dwellTimeMs` a client
// computes for itself is a field an abuser sets to whatever passes. They are
// omitted rather than faked, which costs two of the five flag reasons on this
// transport (`bot_suspected_dwell_time`, `bot_suspected_honeypot`) and keeps the
// other three, all of which are derived from the submission itself.

import { z } from "zod";

/**
 * The per-field codes a client can act on locally.
 *
 * SCREAMING_SNAKE, like every other input module here, and deliberately NOT the
 * `lowercase_snake` of `@dim/contract/api`'s error vocabulary: these are refusals
 * a client computes for ITSELF before any round trip, and the two casings are how
 * a reader tells "the server said no" from "the form did".
 */
export const WELFARE_REPORT_INPUT_CODES = [
  "CONTACT_MODE_REQUIRED",
  "KIND_REQUIRED",
  "SEVERITY_REQUIRED",
  "DESCRIPTION_REQUIRED",
  "DESCRIPTION_TOO_SHORT",
  "SUBJECT_KIND_REQUIRED",
  "SUBJECT_DESCRIPTION_REQUIRED",
  "COORDS_REQUIRED",
  "COORDS_OUT_OF_RANGE",
  "OCCURRED_AT_INVALID",
  "CONTACT_REQUIRED",
  "COMMAND_REQUIRED",
  "ADDRESS_REQUIRED",
] as const;

export type WelfareReportInputCode = (typeof WELFARE_REPORT_INPUT_CODES)[number];

/**
 * The nine kinds of the Ley 14.346 catalogue.
 *
 * IT IS A COPY AND IT IS NOT A TRANSCRIPTION, which is a distinction this repo
 * has paid for. `packages/contract` is installable by a React Native app and may
 * import nothing from `@/src` or `@/db`, so the vocabulary has to exist twice —
 * once here and once in `src/modules/welfare/domain/types.ts`, over a third copy
 * that outranks both: the `welfare_report_kind` PostgreSQL enum in `db/schema.ts`.
 * Three copies is how a list rots.
 *
 * What stops it is that nobody re-types it: `__tests__/welfare-report-kind-
 * catalog.test.ts` asserts all THREE are the same array, in order, in both
 * directions. A kind added to the enum and forgotten here is red; a kind invented
 * here that Postgres would refuse is red; a reordering is red. The order is
 * load-bearing on purpose — an equality over sorted sets would let the two drift
 * in presentation while agreeing in content, and this list is also the order the
 * wizard offers.
 */
export const WELFARE_REPORT_KINDS = [
  "abandonment",
  "neglect",
  "physical_abuse",
  "chained",
  "no_shelter",
  "hoarding",
  "dog_fighting",
  "trafficking",
  "other",
] as const;

export type WelfareReportKind = (typeof WELFARE_REPORT_KINDS)[number];

/**
 * The THREE severities a citizen can actually pick — not the four the column
 * holds.
 *
 * `welfare_report_severity` has `low`, `medium`, `high` and `critical`, and the
 * web's own wizard can produce exactly three of them: `Step2Severity.tsx` maps
 * its three cards (`sospecha`, `moderado`, `grave_urgente`) onto `low`, `medium`
 * and `critical`. `high` is unreachable from a citizen surface by construction
 * and `src/modules/welfare/domain/types.ts` says why — it exists for
 * server-authoritative paths, and the citizen label table gives it the plain word
 * "Grave" rather than inventing a fourth card for it.
 *
 * SO THIS DOOR IS ONE VALUE NARROWER THAN THE WEB'S SERVER-SIDE CHECK, which
 * accepts all four (`WELFARE_KINDS`/`WELFARE_SEVERITIES` in welfare/actions.ts),
 * and the narrowing is deliberate: the phone IS the citizen wizard, so accepting
 * a severity the citizen wizard cannot produce would only ever be accepting one
 * from a hand-rolled caller. Tighter is the safe direction — it grants nothing
 * the browser grants — and it is written down so it stays a decision.
 *
 * THE WIRE CARRIES THE COLUMN'S VOCABULARY, NOT THE CARDS'. The three card names
 * are a rendering of these three values, the mapping lives in the wizard, and a
 * second mapping on this transport would be a second place for the pair to
 * disagree about what "grave" means.
 */
export const WELFARE_REPORT_CITIZEN_SEVERITIES = ["low", "medium", "critical"] as const;

export type WelfareReportCitizenSeverity = (typeof WELFARE_REPORT_CITIZEN_SEVERITIES)[number];

/**
 * What the denuncia is ABOUT. Same four the column holds and the web posts.
 *
 * `registered_pet` is deliberately NOT here, and it is the only member of the
 * database's vocabulary this transport drops. Naming a registered animal means
 * sending its `DIM-XXXX-XXXX` public token, and that token is printed on the
 * physical tag and published for every lost animal on `/perdidas` with no login
 * — so a token field on THIS door would let any holder of a public token append
 * `maltreatment_reported` to that animal's spine, which its owner reads.
 * `submit-claim-dispute.ts` records what a caller-supplied token in that position
 * cost the last time it was there.
 *
 * The web's wizard resolves the token through `lookupPetForDenuncia`, which is a
 * throttled public lookup with its own census entry; wiring a second path to the
 * same act from a bearer door is a decision with its own review, not a field.
 * `unowned_animal` covers the animal in front of the reporter, which is what a
 * phone in the street is for.
 */
export const WELFARE_REPORT_SUBJECT_KINDS = ["unowned_animal", "location", "general"] as const;

export type WelfareReportSubjectKind = (typeof WELFARE_REPORT_SUBJECT_KINDS)[number];

/** The description floor the web enforces server-side, in the same words. */
export const WELFARE_DESCRIPTION_MIN_LENGTH = 20;

/**
 * Caps on the free text this door accepts.
 *
 * `welfare_reports.description` and `subject_description` are unbounded `text`
 * and the web's writer caps neither, so — by `resolvePetIdentityLengths`'s rule —
 * a cap invented here could refuse a value the registry already holds. It cannot,
 * because nothing on this door ever sends a value BACK for re-submission: every
 * request is a new denuncia. What the cap does is bound a single anonymous POST,
 * which is the one thing an unbounded `text` column on a public-ish intake does
 * not do. Generous on purpose — 4 000 characters is several pages of testimony.
 */
export const WELFARE_DESCRIPTION_MAX_LENGTH = 4_000;
export const WELFARE_SUBJECT_DESCRIPTION_MAX_LENGTH = 1_000;
export const WELFARE_ADDRESS_MAX_LENGTH = 300;
export const WELFARE_JURISDICTION_MAX_LENGTH = 120;
export const WELFARE_SYMPTOMS_MAX_LENGTH = 1_000;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length > 0 ? value : null))
    .nullable()
    .optional()
    .transform((value) => value ?? null);

/**
 * The facts of the denuncia — everything except who is sending it.
 *
 * COORDINATES ARE REQUIRED, and this copies a server-side rule rather than a
 * form's convenience. `createWelfareReportAction` passes `requireCoords: true` to
 * `normalizeLocationForWrite` with the reason written out: the authority routes
 * on the point, and a denuncia with no point is a denuncia no queue can pick up.
 * The web's wizard blocks the submit client-side and the action enforces it
 * again; this is the same rule at the same layer, stated once.
 */
const factsShape = {
  kind: z.enum(WELFARE_REPORT_KINDS, { error: "KIND_REQUIRED" }),
  severity: z.enum(WELFARE_REPORT_CITIZEN_SEVERITIES, { error: "SEVERITY_REQUIRED" }),
  description: z
    .string({ error: "DESCRIPTION_REQUIRED" })
    .trim()
    .min(1, { error: "DESCRIPTION_REQUIRED" })
    .min(WELFARE_DESCRIPTION_MIN_LENGTH, { error: "DESCRIPTION_TOO_SHORT" })
    .max(WELFARE_DESCRIPTION_MAX_LENGTH, { error: "DESCRIPTION_REQUIRED" }),
  subjectKind: z.enum(WELFARE_REPORT_SUBJECT_KINDS, { error: "SUBJECT_KIND_REQUIRED" }),
  subjectDescription: z
    .string({ error: "SUBJECT_DESCRIPTION_REQUIRED" })
    .trim()
    .min(1, { error: "SUBJECT_DESCRIPTION_REQUIRED" })
    .max(WELFARE_SUBJECT_DESCRIPTION_MAX_LENGTH, { error: "SUBJECT_DESCRIPTION_REQUIRED" }),
  locationLat: z
    .number({ error: "COORDS_REQUIRED" })
    .min(-90, { error: "COORDS_OUT_OF_RANGE" })
    .max(90, { error: "COORDS_OUT_OF_RANGE" }),
  locationLng: z
    .number({ error: "COORDS_REQUIRED" })
    .min(-180, { error: "COORDS_OUT_OF_RANGE" })
    .max(180, { error: "COORDS_OUT_OF_RANGE" }),
  locationAddress: optionalText(WELFARE_ADDRESS_MAX_LENGTH),
  /**
   * The jurisdiction of the CANDIDATE the person picked in `resolve_location`,
   * echoed back here — the same echo shape the web's intake already uses, and
   * the fix for the gap the 2026-08-31 walkthrough measured: `resolve_location`
   * handed the phone candidates CARRYING province and locality, the person
   * picked one, and `file` dropped the pair — so every mobile denuncia landed
   * "jurisdicción sin verificar" while the best-resolved row in the table was
   * the only one flagged. Optional and nullable on purpose: absent means the
   * person typed an address no geocoder confirmed, and the D.11 gate then takes
   * its text-inference path and earns the mark honestly.
   */
  locationProvince: optionalText(WELFARE_JURISDICTION_MAX_LENGTH),
  locationLocality: optionalText(WELFARE_JURISDICTION_MAX_LENGTH),
  /**
   * What the reporter observed on the animal, verbatim — optional.
   *
   * THIS FIELD WAS ABSENT FOR A WHILE, AND ITS ABSENCE WAS A REPAIR. The
   * module carried one for most of a day, the mobile screen asked "¿Notaste
   * algún síntoma en el animal?", and the answer went NOWHERE:
   * `welfare_reports` had no column, and the value's only consumer was the
   * `symptom_observed` pet-event bridge inside `if (subjectKind ===
   * "registered_pet" && subjectPetId)` — a branch this door cannot reach. A
   * field the server structurally discards is worse than a missing one, so
   * the field was removed and the hole documented here for the PO.
   *
   * THE COLUMN EXISTS NOW (migration 0209, PO decision 2026-09-01: campo
   * propio rather than folding testimony into `description`). The writers
   * store it and the /gob detail and MPF export read it, so the field is back
   * on the wire honestly. The citizen wizard and the mobile screen still do
   * not ASK — reopening that question is a product decision, not a transport
   * one — but a client that sends the value now sends it somewhere real.
   */
  observedSymptoms: optionalText(WELFARE_SYMPTOMS_MAX_LENGTH),
  /**
   * When it happened — an ISO-8601 instant, optional.
   *
   * A DATE AND NOT A DATE-ONLY STRING, unlike `@dim/contract/input`'s
   * `ar-calendar-day.ts`, because `welfare_reports.occurred_at` is a
   * `timestamptz` and the web parses a `datetime-local` into one. A future
   * instant is refused: a denuncia is testimony about something that already
   * happened, and the flag heuristics read the gap between `occurred_at` and
   * `created_at`.
   */
  occurredAt: z
    .string()
    .datetime({ offset: true, error: "OCCURRED_AT_INVALID" })
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  /**
   * The idempotency key for the pet-event bridge, passed straight through.
   *
   * It bounds NOTHING on this transport today and it is here anyway, which needs
   * saying so nobody reads it as a retry promise. The bridge inserts it guards
   * only fire for `subjectKind === "registered_pet"`, which this door does not
   * accept — so on every request this door can make, the key is carried and
   * never consulted. Re-sending a denuncia after a timeout creates a SECOND
   * denuncia with a second reference code, and `computeFlagReasons` catches the
   * pair as `duplicate_within_24h`. The field exists so the day this door grows
   * a registered-pet member it does not also have to grow a wire field.
   */
  clientIdempotencyKey: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null)),
} as const;

/**
 * ANÓNIMA. The member with nowhere to put an identity.
 *
 * It is not "the same object with the contact fields omitted" — zod would strip
 * unknown keys either way, and stripping is not the property being claimed.
 * What is claimed is that a reader of this file can see that the anonymous shape
 * HAS no such fields, and that the handler destructuring it cannot reach for one.
 */
const anonymous = z.object({
  command: z.literal("file"),
  contactMode: z.literal("anonymous"),
  ...factsShape,
});

/**
 * CON CONTACTO. At least one way to reach the reporter, and the "at least one"
 * is the rule the web's own step enforces before it enables its submit.
 *
 * The e-mail is what the follow-up flow needs: `/denuncias/codigo/[code]` mints
 * an `access_link` token INTO an address already on the record, so a reporter who
 * left none can never be sent one. That is the second factor working as designed,
 * and it is the honest cost of choosing anonymity — said out loud here because
 * the choice is made on a screen, once, and cannot be revised afterwards.
 */
const withContact = z
  .object({
    command: z.literal("file"),
    contactMode: z.literal("with_contact"),
    // AN EMPTY STRING IS "NO E-MAIL", NOT A MALFORMED ONE (A5-ciudadanas-01).
    // `z.email()` runs BEFORE `.nullable().optional()` can help, so `""` — what
    // a form sends for a box somebody left alone — failed with CONTACT_REQUIRED
    // pointing at the e-mail field, and the "dejo mi teléfono" path could not be
    // sent AT ALL: the at-least-one rule below never ran. Measured on the native
    // client, where the only two contact fields are these; the same shape is
    // reachable from any caller that sends both keys.
    //
    // The blank is normalised to `null` FIRST and the address check runs after
    // it, so a real typo still answers CONTACT_REQUIRED on this field and the
    // superRefine still refuses a submission with neither.
    reporterContactEmail: z
      .string()
      .trim()
      .max(320)
      .nullable()
      .optional()
      .transform((value) => (value ? value : null))
      .pipe(z.email({ error: "CONTACT_REQUIRED" }).nullable()),
    reporterContactPhone: z
      .string()
      .trim()
      .max(40)
      .nullable()
      .optional()
      .transform((value) => (value ? value : null)),
    ...factsShape,
  })
  .superRefine((value, ctx) => {
    if (value.reporterContactEmail || value.reporterContactPhone) return;
    ctx.addIssue({ code: "custom", message: "CONTACT_REQUIRED", path: ["reporterContactEmail"] });
  });

export const welfareReportFileInputSchema = z.discriminatedUnion("contactMode", [
  anonymous,
  withContact,
]);

/**
 * ¿DÓNDE ES? — resolve a typed address into candidate points, so the person can
 * pick the one they mean.
 *
 * WHY THIS COMMAND EXISTS AT ALL, WHICH IS THE HONEST VERSION OF "the phone has
 * no map". `file` requires exact coordinates, because the web's intake requires
 * them: `createWelfareReportAction` passes `requireCoords: true` with the reason
 * written out (QA fix #3A) — the authority routes on the point. That rule is not
 * weakened here and must not be.
 *
 * But a React Native client has no way to produce a point on its own. There is
 * no `expo-location` in this app and no map component: both are native modules,
 * which is an EAS build, which is the wall the attachments, the pet photo and
 * the claim dispute all stand behind. Without this command the endpoint would be
 * a door with no possible caller.
 *
 * SO THE SERVER RESOLVES IT, THROUGH THE WEB'S OWN GEOCODER — the same
 * `geocodeAddressPublicAction` the DenunciaWizard's address field calls,
 * spending the same `geocode_public` bucket. That is not a parallel path; it is
 * the existing one, called from a second door.
 *
 * AND THE PERSON CONFIRMS, which is what keeps the point honest. The web
 * auto-picks a single forward-geocode match and says "Encontramos: X. Ajustá el
 * pin si no es el punto exacto" — so the browser's DEFAULT is a geocoded point
 * somebody may or may not adjust. This command returns the candidates and the
 * screen makes the person choose one; what it cannot offer is the drag, which is
 * the map. The gap is a nudge, not a guarantee: it is written down here rather
 * than described as parity.
 *
 * IT IS A READ WEARING A POST, and deliberately on this route rather than its
 * own: the two commands are two halves of one act (nobody resolves an address
 * for fun on a denuncia form), and one route means one per-IP counter that
 * alternating between them cannot escape — the argument `me/pet-claims` makes
 * about `lookup` and `claim_free`.
 */
export const welfareReportResolveLocationInputSchema = z.object({
  command: z.literal("resolve_location"),
  addressText: z
    .string({ error: "ADDRESS_REQUIRED" })
    .trim()
    .min(3, { error: "ADDRESS_REQUIRED" })
    .max(WELFARE_ADDRESS_MAX_LENGTH, { error: "ADDRESS_REQUIRED" }),
});

/**
 * A PLAIN UNION AND NOT A `discriminatedUnion("command")`, and the reason is a
 * shape rather than a preference: `file` is ITSELF a discriminated union (on
 * `contactMode`), so `command` cannot be the sole discriminator without
 * flattening the four combinations into four schemas and losing the property
 * this module exists for — that the anonymous member has nowhere to put a
 * contact.
 *
 * THE COST IS REAL AND IT IS PAID BY THE CLIENT, NOT BY THE ROUTE, and this
 * paragraph used to wave it away ("not a cost this surface pays"). Measured on
 * 2026-08-30 by a screen test: `z.union` tries EVERY member and collects every
 * member's issues, so a `file` body with no coordinates comes back carrying
 * `ADDRESS_REQUIRED` — the OTHER member's complaint about a field the caller
 * never meant to send. `firstWelfareReportInputCode` cannot tell the two apart,
 * because at that point the intent is gone.
 *
 * The route is genuinely unaffected: it collapses every parse failure to one
 * `invalid_request` key on purpose, so which member complained changes nothing.
 * A CLIENT is affected, and the fix is that a client parses the member it is
 * actually sending — both are exported for exactly that — and this union stays
 * what it is, the server's backstop over a body whose intent it does not know.
 */
export const welfareReportCommandInputSchema = z.union([
  welfareReportResolveLocationInputSchema,
  welfareReportFileInputSchema,
]);

export type WelfareReportCommandInput = z.infer<typeof welfareReportCommandInputSchema>;
export type WelfareReportCommand = WelfareReportCommandInput["command"];
export type WelfareReportInput = z.infer<typeof welfareReportFileInputSchema>;
export type WelfareReportContactMode = WelfareReportInput["contactMode"];

/**
 * A COMPILE-TIME proof that the anonymous member carries no contact field.
 *
 * The whole anonymity argument in this file's header rests on a shape, and a
 * shape is exactly the kind of claim that survives an edit which quietly breaks
 * it: someone folding the two members back into one object with optional fields
 * would leave every runtime test green (an anonymous submission simply would not
 * SEND them) while deleting the property. These two lines fail to compile
 * instead. Same instrument as `pet-claim.ts`'s `CommandsAgree`.
 */
type AnonymousMember = Extract<WelfareReportInput, { contactMode: "anonymous" }>;
type AnonymousCarriesNoContact = "reporterContactEmail" extends keyof AnonymousMember
  ? ["the anonymous member grew a contact field", keyof AnonymousMember]
  : "reporterContactPhone" extends keyof AnonymousMember
    ? ["the anonymous member grew a contact field", keyof AnonymousMember]
    : true;
const _anonymousCarriesNoContact: AnonymousCarriesNoContact = true;
void _anonymousCarriesNoContact;

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstPetClaimCommandInputCode` — same shape, same reason.
 */
export function firstWelfareReportInputCode(
  error: z.ZodError<unknown>,
): WelfareReportInputCode | null {
  const issues = flattenIssues(error.issues);
  for (const issue of issues) {
    const code = issue.message;
    if ((WELFARE_REPORT_INPUT_CODES as readonly string[]).includes(code)) {
      return code as WelfareReportInputCode;
    }
  }
  for (const issue of issues) {
    if (issue.path[0] === "command") return "COMMAND_REQUIRED";
    if (
      issue.code === "invalid_union" ||
      issue.path.length === 0 ||
      issue.path[0] === "contactMode"
    ) {
      return "CONTACT_MODE_REQUIRED";
    }
  }
  return null;
}

/**
 * Every issue in the tree, parents before children.
 *
 * WHY, MEASURED RATHER THAN REASONED ABOUT. `z.union` reports ONE issue —
 * `{ code: "invalid_union", errors: [[…], […]] }` — whenever more than one
 * member has something to say, and the per-field messages live inside `errors`
 * rather than on `error.issues`. Without this walk the first loop matched
 * nothing on those bodies and the fallback answered `CONTACT_MODE_REQUIRED` for
 * all of them: a denuncia refused for a missing point would have told the person
 * to choose whether to send it anonymously.
 *
 * IT IS A REPAIR AND NOT THE FIX, and saying so is the point of this paragraph.
 * zod HOISTS the single-member case — a body whose `command` matches exactly one
 * member comes back with that member's issues directly, which is why the
 * `description: "corto"` case never showed the defect and why the fence for this
 * walk has to use a body that fails in BOTH members. And on a genuinely nested
 * body the walk yields the FIRST member's complaint, which for a `file` body is
 * `resolve_location`'s `ADDRESS_REQUIRED` — a real code about a field the caller
 * never meant to send. Better than the fallback, and still not right.
 *
 * The right answer is that a CLIENT parses the member it is sending
 * (`welfareReportFileInputSchema` / `welfareReportResolveLocationInputSchema`,
 * both exported for this), where zod narrows and every code is about a field the
 * caller actually filled in. This walk is what keeps the union's own answer from
 * being actively misleading for anyone who does not.
 *
 * The eight sibling `first…InputCode` functions in this package need none of
 * this: `discriminatedUnion` narrows to ONE member. `welfare-report.ts` is the
 * only module here whose top level is a plain union — because `file` is itself a
 * discriminated union — so it is the only one where the nesting exists at all.
 */
function flattenIssues(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  const out: z.core.$ZodIssue[] = [];
  for (const issue of issues) {
    out.push(issue);
    const nested = (issue as { errors?: readonly (readonly z.core.$ZodIssue[])[] }).errors;
    if (Array.isArray(nested)) {
      for (const group of nested) out.push(...flattenIssues(group));
    }
  }
  return out;
}
