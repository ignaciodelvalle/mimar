// The phone's amend allowlist is a CACHE of a server fact — this is its drift
// detector (A2-alta-asentar-02, mobile audit 2026-09-07).
//
// WHAT THE DEFECT WAS. `EventFactV1` is `{field, label, value}` and `value` is
// the DISPLAY string: `eventPayloadDetails` (lib/events/events.ts) renders a date
// through `toLocaleDateString("es-AR")`, an enum through a label table and a
// weight through `formatWeightKg`. The native "Corregir registro" form pre-filled
// that text and posted the edited TEXT back as the RAW payload value. Editing
// "Próxima dosis 12/03/2026" to 15/03/2026 wrote the STRING "15/03/2026" into
// `next_due_at`; the projection drops it and the history reads "se borró".
// Editing it to 12/04/2026 is parsed US-style as 4 December — silently wrong,
// and nothing in the data marks it as wrong. The spine is APPEND-ONLY
// (CLAUDE.md invariant 2), so both are permanent.
//
// THE MITIGATION, AND WHY IT NEEDS THIS FILE. The phone now edits a row only when
// it can NAME it as one the projection renders VERBATIM
// (`PASS_THROUGH_FACTS`, apps/mobile/src/pets/event-detail-view-model.ts). That
// list is an ALLOWLIST, so a fact key or an event type added next month is
// read-only by default — but it is still a phone's copy of a decision only
// `lib/events/events.ts` makes, and a phone cannot read that file at runtime.
// CLAUDE.md invariant 3 is exactly this case: a cache is allowed, and it must
// DECLARE itself and carry drift detection. This is the detection.
//
// THE RULE. Every (event type, field) the phone allowlists must appear in that
// type's arm of the `eventPayloadDetails` switch as a BARE two-argument
// `push("Label", "field")` — no transform, and never `pushDate`. Add a transform
// to `batch` tomorrow and this goes red, in the same run that ships the
// transform, naming the pair.
//
// THE DIRECTION IS DELIBERATE: SUBSET, NOT EQUALITY. A pass-through row the phone
// does NOT list is the phone being conservative, which is the safe direction and
// must not red a server change. A LISTED row that stops being pass-through is the
// unsafe direction, and that is what fails.
//
// WHY IT IS A ROOT VITEST FENCE. It is the only instrument that can see both
// trees at once: `apps/mobile`'s jest cannot import server code, and the mobile
// bundle must not carry `lib/events/events.ts`. Same instrument and same reason
// as `__tests__/mobile-a11y-fences.test.ts`.
//
// WHAT THIS FENCE IS NOT. It does not check the spine's payload SCHEMA, because
// the schema is no defence here: `vaccination_administered.next_due_at` is
// `z.string().nullable()` (lib/events/event-schemas.ts) — "15/03/2026" validates
// happily. That is worth knowing for the proper fix, which will have to give the
// field a shape before validating a change against it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { EventType } from "@/db/schema";
import { PayloadSchemas } from "@/lib/events/event-schemas";
import { AMENDABLE_EVENT_TYPES } from "@/lib/infra/amendment";

const ROOT = resolve(__dirname, "..");
const PROJECTION = readFileSync(resolve(ROOT, "lib/events/events.ts"), "utf-8");
const VIEW_MODEL = readFileSync(
  resolve(ROOT, "apps/mobile/src/pets/event-detail-view-model.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// The SERVER's census: what each `case` arm of `eventPayloadDetails` renders,
// and how.
// ---------------------------------------------------------------------------

/**
 * The text of `eventPayloadDetails`, from its `switch (eventType)` to the
 * function's end.
 *
 * Sliced rather than read whole because `eventPayloadSummary` below it switches
 * on the same identifier and mentions the same keys — reading the file as one
 * string would attribute the summary's `str("kg")` to the detail projection.
 */
function detailsSwitch(source: string): string {
  const start = source.indexOf("export function eventPayloadDetails");
  const end = source.indexOf("export function eventPayloadSummary");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("eventPayloadDetails / eventPayloadSummary not found — the fence is blind");
  }
  return source.slice(start, end);
}

type Row = { field: string; transformed: boolean; dated: boolean };

/**
 * Every row one event type's arm emits.
 *
 * `push("Label", "key")` is pass-through. `push("Label", "key", …)` — anything
 * in the third position — is a TRANSFORMATION, and so is every `pushDate`. The
 * arm may nest (`movement_recorded` branches on `sub_kind`), which is why this
 * scans the arm's TEXT rather than trying to parse statements.
 */
function rowsOfArm(arm: string): Row[] {
  const rows: Row[] = [];
  const push = /\bpush\(\s*"[^"]*"\s*,\s*"([^"]+)"\s*([,)])/g;
  let match = push.exec(arm);
  while (match !== null) {
    rows.push({ field: match[1], transformed: match[2] === ",", dated: false });
    match = push.exec(arm);
  }
  const pushDate = /\bpushDate\(\s*"[^"]*"\s*,\s*"([^"]+)"\s*\)/g;
  match = pushDate.exec(arm);
  while (match !== null) {
    rows.push({ field: match[1], transformed: true, dated: true });
    match = pushDate.exec(arm);
  }
  return rows;
}

/** Each `case "x":` arm of the details switch, up to the next `case`/`default`. */
function armsByEventType(switchText: string): Map<string, string> {
  const arms = new Map<string, string>();
  const caseToken = /case "([a-z_]+)":/g;
  const boundaries: Array<{ type: string; start: number }> = [];
  let match = caseToken.exec(switchText);
  while (match !== null) {
    boundaries.push({ type: match[1], start: match.index + match[0].length });
    match = caseToken.exec(switchText);
  }
  const defaultAt = switchText.indexOf("default:");
  for (let i = 0; i < boundaries.length; i += 1) {
    const next = boundaries[i + 1];
    const end = next
      ? next.start - `case "${next.type}":`.length
      : defaultAt > 0
        ? defaultAt
        : switchText.length;
    arms.set(boundaries[i].type, switchText.slice(boundaries[i].start, end));
  }
  return arms;
}

const ARMS = armsByEventType(detailsSwitch(PROJECTION));
const SERVER_ROWS = new Map<string, Row[]>(
  [...ARMS].map(([type, arm]) => [type, rowsOfArm(arm)] as const),
);

// ---------------------------------------------------------------------------
// The PHONE's allowlist, read from its source.
// ---------------------------------------------------------------------------

/**
 * One `Readonly<Record<string, readonly string[]>>` constant, parsed out of the
 * view model.
 *
 * Read as TEXT rather than imported: the module is React Native source under a
 * separate tsconfig and importing it into the root vitest run would drag the
 * mobile toolchain into `test:verified`.
 *
 * IT THROWS RATHER THAN RETURNS SHORT, because every way this parser can fail is
 * SILENT. `/…\[([^\]]*)\]/` reads an array literal and nothing else: a spread
 * (`...COMMON_TEXT`), a constant reference in place of a literal, or a comment
 * containing `]` inside the brackets all yield an EMPTY or TRUNCATED field list
 * while the runtime object still permits those pairs — no offence is raised, the
 * fence passes, and the floors below cannot see a partial miss either (they are
 * totals). So: an entry that parsed to zero fields is a parser failure by
 * definition — the source convention is that a type with nothing to list is
 * ABSENT, never `[]` — and the entry count is cross-checked against the `: [`
 * occurrences in the same body, which catches the entry a spread swallowed whole.
 */
function phoneAllowlist(source: string, constName: string): Map<string, string[]> {
  const start = source.indexOf(`const ${constName}`);
  if (start < 0) {
    throw new Error(`${constName} not found in the view model — the fence is blind`);
  }
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const body = source.slice(open, end);
  const out = new Map<string, string[]>();
  const entry = /([a-z_]+)\s*:\s*\[([^\]]*)\]/g;
  let match = entry.exec(body);
  while (match !== null) {
    const fields = [...match[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (fields.length === 0) {
      throw new Error(
        `${constName}.${match[1]} parsed to zero fields — this parser reads array LITERALS only, so a spread, a constant reference or a bracket inside a comment reads as empty while the runtime object still permits those pairs. The fence is blind.`,
      );
    }
    out.set(match[1], fields);
    match = entry.exec(body);
  }
  // Every key of the object, counted at the start of its line — catches the
  // entry whose value is a CONSTANT REFERENCE rather than a literal, which the
  // entry regex above skips in silence.
  const declaredKeys = (body.match(/^\s*[a-z_]+\s*:/gm) ?? []).length;
  if (declaredKeys !== out.size) {
    throw new Error(
      `${constName} declares ${declaredKeys} keys but ${out.size} parsed as array literals — the fence is blind`,
    );
  }
  // Every quoted string in the body, counted against the fields collected —
  // catches TRUNCATION, where `[^\]]*` stopped early at a `]` inside a comment
  // and the tail of that array was never read.
  const quoted = (body.match(/"[^"]+"/g) ?? []).length;
  const collected = [...out.values()].flat().length;
  if (quoted !== collected) {
    throw new Error(
      `${constName} contains ${quoted} quoted strings but ${collected} fields were collected — the fence is blind`,
    );
  }
  return out;
}

const PHONE = phoneAllowlist(VIEW_MODEL, "PASS_THROUGH_FACTS");
const PHONE_REQUIRED = phoneAllowlist(VIEW_MODEL, "NON_NULLABLE_FACTS");

type Offence = { pair: string; why: string };

const OFFENCES: Offence[] = [];
for (const [eventType, fields] of PHONE) {
  const rows = SERVER_ROWS.get(eventType);
  for (const field of fields) {
    const pair = `${eventType}.${field}`;
    if (!rows) {
      OFFENCES.push({ pair, why: "the projection has no arm for this event type at all" });
      continue;
    }
    // EVERY OCCURRENCE, NOT THE FIRST. `movement_recorded`'s arm is scanned as
    // one flat text spanning three `sub_kind` branches, so a key pushed twice —
    // bare in one branch, transformed in another — would have handed a `.find()`
    // the bare row and passed while the transformed one stayed editable. The
    // offence is ANY match being formatted.
    const matches = rows.filter((r) => r.field === field);
    if (matches.length === 0) {
      OFFENCES.push({ pair, why: "the projection no longer renders this key" });
    } else if (matches.some((r) => r.dated)) {
      OFFENCES.push({ pair, why: "the projection renders it through pushDate (dd/mm/yyyy)" });
    } else if (matches.some((r) => r.transformed)) {
      OFFENCES.push({ pair, why: "the projection renders it through a transform" });
    }
  }
}

describe("the phone may only offer to correct a row the projection renders VERBATIM", () => {
  it("finds no allowlisted (event type, field) that the server formats", () => {
    expect(OFFENCES.map((o) => `${o.pair} — ${o.why}`)).toEqual([]);
  });

  it("allowlists nothing outside the amendable set, where no form can reach it", () => {
    // Not a safety rule — a correctness one. A type outside
    // AMENDABLE_EVENT_TYPES can never open the form, so an entry for it is dead
    // weight that reads as a decision somebody made.
    const amendable = new Set<string>(AMENDABLE_EVENT_TYPES);
    expect([...PHONE.keys()].filter((type) => !amendable.has(type))).toEqual([]);
  });

  // NON-VACUITY. Every failure mode of this fence is silence: a slice that stops
  // finding the function, a regex that stops matching `push(`, a parser that
  // reads an empty allowlist. All three would report zero offences and read as a
  // pass — the failure this repo's fences are required to close.
  it("actually reads both sides and finds what it judges", () => {
    // MEASURED 2026-09-07 against the real corpus, not estimated:
    //   · lib/events/events.ts — 10 `case` arms in the details switch and 34
    //     rows, of which 24 are pass-through, 6 carry a transform and 4 are
    //     `pushDate`.
    //   · the phone allowlist — 6 event types, 16 pairs. That is the
    //     pass-through set restricted to `AMENDABLE_EVENT_TYPES`, MINUS four the
    //     phone refuses for a reason this fence cannot see: `to_country` and
    //     `origin_country` are ISO-3166 codes (verbatim, but not free text), and
    //     `to_province`/`to_locality` are half of an identity whose other half is
    //     `to_locality_id`. Four more pass-through rows are left out because they
    //     belong to `microchip_implanted` and `post_adoption_checkin`, which no
    //     correction form can open.
    // The floors sit just under each census so ordinary churn (one key added,
    // one removed) does not trip them and a COLLAPSE does. They were set against
    // the numbers above rather than inherited from another fence: the
    // enum-fallback fence's 90/30/25 count FILES and `default:` arms, a
    // different corpus entirely. `dated` gets the widest margin of the four —
    // 3 against a census of 4 — because it is the smallest population and one
    // `movement_recorded` sub-kind losing its date would otherwise red the gate
    // for a change with nothing to do with this defect.
    const rows = [...SERVER_ROWS.values()].flat();
    expect(ARMS.size).toBeGreaterThanOrEqual(8);
    expect(rows.length).toBeGreaterThanOrEqual(28);
    expect(rows.filter((r) => !r.transformed).length).toBeGreaterThanOrEqual(20);
    expect(rows.filter((r) => r.transformed && !r.dated).length).toBeGreaterThanOrEqual(5);
    expect(rows.filter((r) => r.dated).length).toBeGreaterThanOrEqual(3);

    expect(PHONE.size).toBeGreaterThanOrEqual(5);
    // 13 AGAINST A CENSUS OF 16. The first draft of this floor was 16 against a
    // census of 20, which left ZERO margin — a floor with no margin is not a
    // non-vacuity check, it is a tripwire that reds the gate for the next
    // legitimate removal and teaches whoever hits it to edit the number. Four
    // pairs did come off the next day (two ISO country codes, two halves of a
    // locality identity), which is exactly the churn a floor must survive.
    expect([...PHONE.values()].flat().length).toBeGreaterThanOrEqual(13);
  });

  it("still sees the three rows the defect was reported on", () => {
    // Named, because a census that drifted past them would keep passing while
    // the fence had stopped watching the exact keys A2-alta-asentar-02 was
    // filed about.
    const vaccination = SERVER_ROWS.get("vaccination_administered") ?? [];
    expect(vaccination.find((r) => r.field === "next_due_at")?.dated).toBe(true);
    expect(vaccination.find((r) => r.field === "batch")?.transformed).toBe(false);

    const deworming = SERVER_ROWS.get("deworming_administered") ?? [];
    expect(deworming.find((r) => r.field === "type")?.transformed).toBe(true);

    const weight = SERVER_ROWS.get("weight_recorded") ?? [];
    expect(weight.find((r) => r.field === "kg")?.transformed).toBe(true);
  });

  it("offends on a key pushed TWICE when either push is formatted", () => {
    // `movement_recorded`'s arm is one flat text over three `sub_kind` branches,
    // so one key can legitimately appear twice. Taking the FIRST row would have
    // let a transformed second occurrence stay editable — a silent miss, not a
    // loud one, which is the only kind this fence exists to prevent.
    const arm = `
      push("Motivo", "reason");
      push("Motivo", "reason", (v) => v.toUpperCase());`;
    const rows = rowsOfArm(arm);
    expect(rows.filter((r) => r.field === "reason")).toHaveLength(2);
    expect(rows.find((r) => r.field === "reason")?.transformed).toBe(false);
    expect(rows.filter((r) => r.field === "reason").some((r) => r.transformed)).toBe(true);
  });

  it("refuses to read an allowlist it cannot actually parse", () => {
    // THREE SILENT CHANNELS, ARMED. Each one leaves the runtime object permitting
    // pairs this fence never judged, and each one used to report zero offences.
    // Demonstrated on synthetic sources for the reason the transform check above
    // is: a guard you cannot exercise on real data is still worth arming.
    expect(() => phoneAllowlist(`const X = { a: [...COMMON], b: ["k"] };`, "X")).toThrow(
      /parsed to zero fields/,
    );
    expect(() => phoneAllowlist(`const X = {\n  a: COMMON,\n  b: ["k"],\n};`, "X")).toThrow(
      /declares 2 keys but 1 parsed/,
    );
    expect(() => phoneAllowlist(`const X = {\n  a: ["x" /* ] */, "y"],\n};`, "X")).toThrow(
      /quoted strings but 1 fields were collected/,
    );
    // …and it still reads a well-formed one.
    expect(phoneAllowlist(`const X = {\n  a: ["x", "y"],\n};`, "X").get("a")).toEqual(["x", "y"]);
  });

  it("recognises a transform when one is added to an allowlisted key", () => {
    // The rule exercised against a synthetic arm, so a refactor that quietly
    // stops matching `push(` fails HERE rather than passing silently — the
    // lesson of the pending-assertion guard: a defensive check you cannot
    // currently demonstrate on real data is still worth arming.
    const before = `
      push("Lote", "batch");
      pushDate("Próxima dosis", "next_due_at");`;
    const after = `
      push("Lote", "batch", (v) => v.toUpperCase());
      pushDate("Próxima dosis", "next_due_at");`;

    expect(rowsOfArm(before).find((r) => r.field === "batch")?.transformed).toBe(false);
    expect(rowsOfArm(after).find((r) => r.field === "batch")?.transformed).toBe(true);
    expect(rowsOfArm(before).find((r) => r.field === "next_due_at")?.dated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE SECOND CACHE: which of those rows may not be EMPTIED
// ---------------------------------------------------------------------------
//
// The allowlist above governs which ROWS get a box; it says nothing about which
// VALUES may go in one. `buildAmendChanges` sends `null` for an emptied box, and
// several allowlisted keys are `z.string()` in the spine rather than
// `z.string().nullable()` — so emptying "Vacuna" wrote `null` into a required
// field and the projection dropped the row. Nothing re-validates an amended
// payload, which is why the phone has to carry the nullability itself
// (`NON_NULLABLE_FACTS`).
//
// THIS IS THE DRIFT DETECTOR FOR THAT SECOND COPY, and it is not a text scan: it
// runs a REAL payload through the REAL schema and flips one field to `null` at a
// time. Both directions are judged — a key the phone calls required that the
// spine happily nulls is stale copy, and a key the spine refuses that the phone
// does not list is the defect itself, reopened.

type BasePayload = { eventType: string; label: string; payload: Record<string, unknown> };

/**
 * One valid payload per (event type, sub_kind) the allowlist touches.
 *
 * Every NULLABLE allowlisted field carries a non-null value here on purpose:
 * flipping a field that was already `null` would prove nothing. The bases are
 * asserted valid before any probe runs, so a schema change that invalidates one
 * reds this fence instead of quietly making every verdict below meaningless.
 */
const BASE_PAYLOADS: BasePayload[] = [
  {
    eventType: "vaccination_administered",
    label: "vaccination_administered",
    payload: {
      vaccine_name: "Antirrábica",
      brand: "MSD",
      batch: "L-42",
      administered_by: "Vet Palermo",
      next_due_at: null,
    },
  },
  {
    eventType: "deworming_administered",
    label: "deworming_administered",
    payload: { product: "Drontal", type: "internal", next_due_at: null },
  },
  {
    eventType: "sterilization_performed",
    label: "sterilization_performed",
    payload: { procedure: "castration", performed_by: "Vet Palermo", clinic: "Clínica Norte" },
  },
  {
    eventType: "vet_visit_logged",
    label: "vet_visit_logged",
    payload: {
      reason: "control anual",
      diagnosis: "otitis",
      vet_name: "Vet Palermo",
      clinic: "Clínica Norte",
    },
  },
  { eventType: "note_added", label: "note_added", payload: { category: "otro", text: "hola" } },
  {
    eventType: "movement_recorded",
    label: "movement_recorded/jurisdiction_changed",
    payload: {
      sub_kind: "jurisdiction_changed",
      from_country: "AR",
      from_province: "CABA",
      from_locality: "Palermo",
      to_country: "AR",
      to_province: "Buenos Aires",
      to_locality: "La Plata",
      effective_date: "2026-07-01",
      reason: "mudanza",
    },
  },
  {
    eventType: "movement_recorded",
    label: "movement_recorded/cvi_issued",
    payload: {
      sub_kind: "cvi_issued",
      origin_country: "AR",
      cvi_number: "CVI-1",
      issuing_authority: "SENASA",
      issued_date: "2026-07-01",
      chip_iso_country_code: null,
    },
  },
  {
    eventType: "movement_recorded",
    label: "movement_recorded/transport_recorded",
    payload: {
      sub_kind: "transport_recorded",
      corridor_id: "chile",
      direction: "outbound_from_ar",
      travel_date: "2026-07-01",
      mode: "air",
      purpose: "exposición",
    },
  },
];

describe("the phone may only CLEAR a row the spine lets it clear", () => {
  it("declares nothing outside the pass-through allowlist", () => {
    // A required-field entry for a row no form draws is dead weight that reads
    // as a decision somebody made — the same rule the allowlist itself gets.
    const stray: string[] = [];
    for (const [eventType, fields] of PHONE_REQUIRED) {
      const allowed = PHONE.get(eventType) ?? [];
      for (const field of fields) {
        if (!allowed.includes(field)) stray.push(`${eventType}.${field}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("every base payload this fence judges against is itself valid", () => {
    const invalid = BASE_PAYLOADS.filter(
      (base) =>
        PayloadSchemas[base.eventType as EventType]?.safeParse(base.payload).success !== true,
    ).map((base) => base.label);
    expect(invalid).toEqual([]);
    // Non-vacuity: the bases must actually cover the allowlist, or the loop below
    // judges nothing and passes.
    expect(BASE_PAYLOADS.length).toBeGreaterThanOrEqual(8);
  });

  it("agrees with the spine on which allowlisted fields accept null", () => {
    const verdicts: string[] = [];
    let probed = 0;
    for (const base of BASE_PAYLOADS) {
      const schema = PayloadSchemas[base.eventType as EventType];
      if (!schema) {
        verdicts.push(`${base.label} — no schema in PayloadSchemas`);
        continue;
      }
      const required = PHONE_REQUIRED.get(base.eventType) ?? [];
      for (const field of PHONE.get(base.eventType) ?? []) {
        // A key that belongs to another sub_kind is not this base's business.
        if (!(field in base.payload)) continue;
        probed += 1;
        const nullAccepted = schema.safeParse({ ...base.payload, [field]: null }).success;
        if (required.includes(field) && nullAccepted) {
          verdicts.push(
            `${base.label}.${field} — the phone refuses to clear it, the spine accepts null`,
          );
        }
        if (!required.includes(field) && !nullAccepted) {
          verdicts.push(
            `${base.label}.${field} — the spine REFUSES null and NON_NULLABLE_FACTS does not say so: emptying that box writes null into a required field`,
          );
        }
      }
    }
    expect(verdicts).toEqual([]);
    // Measured 2026-09-07: 16 allowlisted pairs, every one of them present in
    // exactly one base. The floor sits under that for the same reason the
    // censuses above do.
    expect(probed).toBeGreaterThanOrEqual(13);
  });
});
