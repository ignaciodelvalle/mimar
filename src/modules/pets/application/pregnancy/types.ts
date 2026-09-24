// Pregnancy use-case types (strangler migration 18/61).

import type { Pet } from "@/db";
import type { PetEventAuthorship } from "@/lib/infra/pet-access";

export type PregnancyFormState = {
  error: string | null;
  /**
   * N3 post-action destination. The action must NOT redirect() — the App
   * Router drops a server action's own redirect in production: the write
   * commits and the screen never moves (lib/ui/full-page-action-nav.ts).
   */
  redirectTo?: string | null;
};

// MOVED TO `@dim/contract/input` on 2026-09-09 and re-exported here, so this
// module's importers — the two web forms, both writers and `replayPetPregnancy`
// — keep reading ONE array. The native app needs the same five strings to draw
// the same picker, and it can only import the contract.
//
// This one is load-bearing beyond the picker: `rederivePregnancyStatus` maps
// each member to a `completed_${outcome}` status the credential prints, so a
// copy drifting from the contract's would produce a status no surface can
// render.
export { PREGNANCY_OUTCOMES, type PregnancyOutcome } from "@dim/contract/input";
// Imported as well as re-exported: `RecordPregnancyEndedParams` below reads the
// type, and a bare `export … from` re-exports without binding it here.
import type { PregnancyOutcome } from "@dim/contract/input";

export type RecordPregnancyStartedParams = {
  pet: Pick<Pet, "id" | "sex" | "species" | "pregnancyStatus" | "publicToken">;
  recordedByUserId: string;
  eventAuthorship: PetEventAuthorship;
  occurredAt: Date;
  weeksAtDiagnosis: number | null;
  vetConsulted: string | null;
  notes: string | null;
  /**
   * Optional, and the web's two forms send none — they read no such field
   * (app/actions/pregnancy.ts:45-48 and :90-94). When present the event insert
   * routes through `insertEventIdempotent` and every side effect after it is
   * skipped on a replay, which is what lets
   * `POST /api/v1/pets/{token}/events` accept this kind at all: that endpoint
   * REQUIRES an `Idempotency-Key` and promises it is honoured, and this writer
   * was excluded from it on the grounds that it could not.
   */
  clientIdempotencyKey?: string | null;
  now?: Date;
};

export type PregnancyRefusal = "not_applicable" | "already_open" | "none_open" | "births_mismatch";

export type RecordPregnancyResult =
  | {
      ok: true;
      eventId: string;
      /** 0 on a replay: that call scheduled nothing, the first one already did. */
      reminderCount: number;
      /** `true` when the key resolved to an event that already existed. */
      wasDuplicate: boolean;
    }
  | {
      ok: false;
      error: string;
      /**
       * WHICH refusal about THE ANIMAL this is — or absent, when the failure
       * was the transaction rather than the animal.
       *
       * IT EXISTS BECAUSE `error` CANNOT CROSS A WIRE. These strings are es-AR
       * prose written for a web form (api-invariants.md §3), so
       * `POST /api/v1/pets/{token}/events` would otherwise have to report every
       * one of them as `event_failed` 500 — telling a client its correct
       * request broke the server, when what happened is that this animal
       * cannot have this event.
       *
       * A DISCRIMINATOR AND NOT A BOOLEAN, by the contract's own bar for a
       * second error code (`packages/contract/src/api/errors.ts`, the
       * `event_date_future` / `event_date_before_birth` note): a code earns its
       * own name when the NEXT MOVE is different. Here three are:
       *
       *   · `not_applicable` — a male, or a species with no known gestation.
       *     There is no next move; this animal can never have this event.
       *     Sex and species share one value because they share that answer.
       *   · `already_open`   — close the pregnancy in follow-up first.
       *   · `none_open`      — record the start first.
       *
       * `births_mismatch` is the fourth and is NOT reachable from the v1
       * endpoint: its contract refuses the combination before the writer runs
       * (`PREGNANCY_BIRTHS_REQUIRED` / `PREGNANCY_BIRTHS_REQUIRES_LIVE_BIRTH`).
       * It is here because the WEB reaches this writer without that schema, and
       * a refusal the endpoint cannot produce is still a refusal the type must
       * be able to name.
       *
       * SAME SHAPE, DIFFERENT STATUS, as `ReplaceMicrochipResult.denied`: that
       * flag marks a refusal about the CALLER (403), these mark refusals about
       * the ANIMAL (409). Two fields rather than one because collapsing them
       * would make the endpoint answer 403 to a person who holds the pet.
       */
      notAllowed?: PregnancyRefusal;
    };

export type RecordPregnancyEndedParams = {
  pet: Pick<Pet, "id" | "pregnancyStatus" | "publicToken" | "name">;
  recordedByUserId: string;
  eventAuthorship: PetEventAuthorship;
  occurredAt: Date;
  outcome: PregnancyOutcome;
  liveBirthsCount: number | null;
  vetConsulted: string | null;
  notes: string | null;
  /** Same contract as the started writer's — see that field. */
  clientIdempotencyKey?: string | null;
  now?: Date;
};
