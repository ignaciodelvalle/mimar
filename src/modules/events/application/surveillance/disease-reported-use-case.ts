// Use-case: createDiseaseReported (writer + types) — T4-I1 / issue #759.
//
// WHY THIS FILE DID NOT EXIST UNTIL NOW
// ---------------------------------------------------------------------------
// `disease_reported` has been in the catalog, in the erasure rules, on
// `/gob/vigilancia`, in the novedades feed, in the choropleth and in the
// panorama's "activas hoy" formula (which literally
// counts `disease_reported='lepto'` and `='hidatidosis'` over 30 days) — and
// the only thing that could ever produce one was a hand-written INSERT. Every
// other event family had a writer; this one was read-only by accident, found
// while enriching QA data on 2026-07-02.
//
// WHO MAY WRITE ONE — the decision #759 asked for
// ---------------------------------------------------------------------------
// A MATRICULATED VET, and the payload settles it before the law does:
// `confirmed_by_lab` is an A4 BUMPER in lib/events/event-confidence.ts. A
// payload with `confirmed_by_lab: true` computes `institutional_verified` —
// the HIGHEST tier in the model, above a vet's own signature — regardless of
// who wrote it. An owner-reachable writer for this type would therefore be a
// button that mints the strongest provenance DIM can express, on an event that
// feeds a government surveillance surface. That is not a gate you place
// carefully; it is one you do not open.
//
// The law agrees and names the same person. Ley 15.465 + Res. MS 1715/2007 +
// Res. CVPBA 05/2020 describe the denuncia ENO as carrying the "vet
// notificante", and the two named diseases in the enum are the zoonoses whose
// reporting duty falls on the professional who saw the animal.
//
// So the AUTH GATE is `recordDiseaseDiagnosisAction`'s, copied exactly: role=vet
// AND matriculaVerified, and NO ownership check — a vet reports on the animal in
// front of them, which may be nobody's in the system. That sibling is the
// precedent in this very module and copying its gate is what keeps the two ENO
// paths from drifting into different answers about who may notify.
//
// THE GATE, THOUGH — NOT THE WHOLE DOOR, and an earlier version of this header
// said "verbatim" without qualification, which a security review was right to
// call too strong (2026-09-23). The sibling ALSO refuses `confirmedByLab`
// without a `labName`; it can ask that because `clinical_info_logged` carries
// `lab_name` / `lab_report_reference`, and `disease_reported`'s strict schema
// carries neither. With no field to demand, the honest move is not a weaker
// guard but a narrower door: this writer's `confirmedByLab` is TYPED `false`,
// so the highest tier it can produce is the vet's own `professional_verified`
// and the A4 bumper is unreachable from here. Lab confirmation stays with the
// path that can record WHICH lab.
//
// WHAT IT DOES NOT DO, stated so the absences read as decisions
// ---------------------------------------------------------------------------
//   · NO CASE. `CASE_ATTACHMENT_RULES.disease_reported` is `mode: "never"`
//     (lib/infra/case-attachment.ts): `outbreak_signal` is the case-opening
//     event of the surveillance family, and a future spike detector — not this
//     writer — is what would attach reports to an `outbreak_investigation`.
//     Opening one here would put a case-shaped thing where the rules say there
//     is none.
//   · NO ENO QUEUE ROW. `enqueueEnoTrigger` guards on
//     `payload.sub_kind === "disease_diagnosis"` and returns silently for
//     anything else, so calling it would be a no-op dressed as durability.
//     Widening that guard is a surveillance decision, not a side effect of
//     adding a writer.
//   · NO AMENDMENT PATH, and this is worth knowing before filing one.
//     `disease_reported` is deliberately absent from `AMENDABLE_EVENT_TYPES`
//     (lib/infra/amendment.ts: "govt surveillance; corrected via official
//     channels"), so a mistake here CANNOT be corrected by an
//     `event_amended` overlay the way a vaccination can. The date and the
//     disease are worth a second look before submitting.
//   · NO SYMPTOM FAN-OUT. `createSymptomObservedWriter` runs a matcher and can
//     emit `outbreak_signal`s because it is handed free text to interpret. A
//     disease report already names the disease; there is nothing to infer.
//
// The outbox enqueue IS called, and today it does nothing: `OUTBOX_RULES` has
// no entry for `disease_reported`, and `enqueueOutboxForEvent` is documented as
// a silent no-op when no rule matches. It is called anyway because both sibling
// writers call it unconditionally, and because that is what makes "send this to
// the province" a one-line rule addition later instead of a change to this
// file.
//
// AUTH IS THE ACTION'S JOB. This writer is auth-agnostic on purpose, like every
// other use-case here, so integration tests can call it without Next.js.

import { validateEventPayload } from "@/lib/events/event-schemas";

import type { EventsRepository } from "../../infrastructure/events-repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The diseases the event schema admits (lib/events/event-schemas.ts).
 *
 * A SECOND COPY of the zod enum, and a deliberate one: the action needs the
 * list to render the select and to refuse an unknown value with a sentence a
 * person can act on, and importing `event-schemas` into a form would drag a
 * 1300-line module into the client bundle to read three strings. The copy is
 * fenced — disease-reported-use-case.test.ts asserts every member validates and
 * that the zod schema refuses anything outside the list.
 */
export const DISEASE_REPORTED_CODES = ["lepto", "hidatidosis", "other"] as const;
export type DiseaseReportedCode = (typeof DISEASE_REPORTED_CODES)[number];

/**
 * Narrow an arbitrary form string to a disease code.
 *
 * The action calls this BEFORE the use-case so an unknown value becomes "Elegí
 * una enfermedad de la lista." rather than a strict-schema throw surfacing as a
 * generic failure — the zod schema is still the one that decides, one layer
 * down, and would refuse the same value if this guard were removed.
 */
export function isDiseaseReportedCode(value: string): value is DiseaseReportedCode {
  return (DISEASE_REPORTED_CODES as readonly string[]).includes(value);
}

export type CreateDiseaseReportedInput = {
  pet: { id: string; jurisdictionProvince: string | null; jurisdictionLocality: string | null };
  /** The reporting vet. Their matrícula is what the action verified. */
  vet: { userId: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  disease: DiseaseReportedCode;
  /**
   * TYPED `false`, NOT `boolean` — the only value any caller may pass today.
   *
   * `confirmed_by_lab: true` is the A4 bumper in
   * lib/events/event-confidence.ts: it computes `institutional_verified`, the
   * HIGHEST tier, for ANY author. `disease_reported` has no lab-reference field
   * to check such a claim against and is deliberately absent from
   * `AMENDABLE_EVENT_TYPES`, so a wrong one could never be corrected. Lab
   * confirmation belongs to `recordDiseaseDiagnosisAction`, whose event type
   * carries `lab_name` and whose guard refuses the flag without one.
   *
   * A LITERAL TYPE rather than a runtime guard because this is a constraint on
   * CALLERS, and the typechecker can hold it for free at every future call site
   * — including one written by somebody who never reads this file. When the
   * schema grows a lab reference, widen this to `boolean` and add the guard in
   * the same change; the type is what will make that change impossible to
   * forget.
   */
  confirmedByLab: false;
  /** ISO date (YYYY-MM-DD) of the first observed clinical signs. */
  dateOfOnset: string;
  /** Parsed from `dateOfOnset` by the action, via the noon-UTC anchor. */
  occurredAt: Date;
  clinicalNotes: string | null;
  /**
   * When present the insert dedupes on it and a replay skips the outbox. The
   * web form posts none; `/api/v1` would require one.
   */
  clientIdempotencyKey?: string | null;
  now?: Date;
};

export type CreateDiseaseReportedResult =
  | { ok: true; eventId: string; wasDuplicate: boolean }
  | { ok: false; error: string };

type Deps = {
  repo: Pick<EventsRepository, "insertEvent" | "insertEventIdempotent" | "enqueueOutbox">;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export async function createDiseaseReported(
  input: CreateDiseaseReportedInput,
  deps: Deps,
): Promise<CreateDiseaseReportedResult> {
  const {
    pet,
    vet,
    eventAuthorship,
    disease,
    confirmedByLab,
    dateOfOnset,
    occurredAt,
    clinicalNotes,
    clientIdempotencyKey = null,
    now = new Date(),
  } = input;

  try {
    let wasDuplicate = false;

    const eventId = await deps.transaction(async (tx) => {
      // `validateEventPayload` and not a hand-built object: the strict zod
      // schema is what refuses an unknown disease code and an extra key, and
      // it is the same schema any future LLM tool definition would read.
      const payload = validateEventPayload("disease_reported", {
        disease,
        confirmed_by_lab: confirmedByLab,
        date_of_onset: dateOfOnset,
        clinical_notes: clinicalNotes,
      });

      const base = {
        petId: pet.id,
        eventType: "disease_reported",
        // THE DAY THE SIGNS STARTED, not the day it was reported. The panorama
        // counts these over a 30-day window and the feed orders by it, so
        // stamping `now` here would move a two-week-old case into today's
        // numbers.
        occurredAt,
        recordedAt: now,
        recordedByUserId: vet.userId,
        ...eventAuthorship,
        payload,
      };

      let event: { id: string };

      if (clientIdempotencyKey != null) {
        const { event: inserted, wasNoop } = await deps.repo.insertEventIdempotent(
          { ...base, clientIdempotencyKey } as Parameters<
            typeof deps.repo.insertEventIdempotent
          >[0],
          tx as Parameters<typeof deps.repo.insertEventIdempotent>[1],
        );
        if (wasNoop) {
          // EARLY RETURN INSIDE THE TRANSACTION, before the outbox. A replay
          // must not enqueue a second notification for a report the province
          // already received; the first submit enqueued it.
          wasDuplicate = true;
          return inserted.id;
        }
        event = inserted;
      } else {
        event = await deps.repo.insertEvent(
          base as Parameters<typeof deps.repo.insertEvent>[0],
          tx as Parameters<typeof deps.repo.insertEvent>[1],
        );
      }

      await deps.repo.enqueueOutbox(
        tx as Parameters<typeof deps.repo.enqueueOutbox>[0],
        {
          id: event.id,
          petId: pet.id,
          eventType: "disease_reported",
          payload: payload as Record<string, unknown>,
        },
        {
          jurisdictionProvince: pet.jurisdictionProvince,
          jurisdictionLocality: pet.jurisdictionLocality,
        },
        now,
      );

      return event.id;
    });

    return { ok: true, eventId, wasDuplicate };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unknown error" };
  }
}
