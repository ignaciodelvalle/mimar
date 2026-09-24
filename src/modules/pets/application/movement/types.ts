// Movement use-case types (movilidad-jurisdiccional Fase 1).

import type { Pet } from "@/db";
import type { PetEventAuthorship } from "@/lib/infra/pet-access";
import type { CorridorId } from "@/lib/reference/cross-border-corridors";

// Input payloads mirror the movement_recorded Zod union in
// lib/events/event-schemas.ts (snake_case, payload_version filled on parse).
// The writer re-validates through validateEventPayload — these types exist
// for compile-time narrowing at call sites, not as the source of truth.

export type JurisdictionChangedMovement = {
  sub_kind: "jurisdiction_changed";
  from_country: string;
  from_province: string | null;
  from_locality: string | null;
  to_country: string;
  to_province: string | null;
  to_locality: string | null;
  /**
   * The `ar_localities` row the animal is leaving, when the caller knows it.
   *
   * Supplied by the caller because only the caller has read the pet. Together
   * with `to_locality_id` — which `recordMovementWriter` fills from the value it
   * writes into the column — it is what lets the schema tell a CORRECTION
   * between two same-named localities of one province apart from a no-op move
   * (L2-3 / L2-5).
   */
  from_locality_id?: string | null;
  /** Filled by `recordMovementWriter`; callers do not set it. See above. */
  to_locality_id?: string | null;
  effective_date: string;
  reason: string | null;
};

export type CviIssuedMovement = {
  sub_kind: "cvi_issued";
  origin_country: string;
  cvi_number: string;
  issuing_authority: string;
  issued_date: string;
  chip_iso_country_code: string | null;
};

export type TransportRecordedMovement = {
  sub_kind: "transport_recorded";
  corridor_id: CorridorId;
  direction: "outbound_from_ar";
  travel_date: string;
  mode: "air" | "land" | "sea" | null;
  purpose: string | null;
};

export type MovementInput =
  | JurisdictionChangedMovement
  | CviIssuedMovement
  | TransportRecordedMovement;

export type RecordMovementParams = {
  pet: Pick<Pet, "id" | "publicToken">;
  recordedByUserId: string;
  eventAuthorship: PetEventAuthorship;
  occurredAt: Date;
  movement: MovementInput;
  notes: string | null;
  now?: Date;
  /**
   * The `ar_localities` row the EDGE already resolved for the destination, when
   * it resolved one.
   *
   * WHY THE WRITER CANNOT WORK THIS OUT FOR ITSELF (L2-2). Both edges resolve
   * the destination STRICTLY, and the owner-facing one can resolve it BY INDEC
   * ID — which is the only way to tell two same-named localities of one province
   * apart, because `localityByName` is province-scoped and settles a homonym
   * with `.orderBy(departmentName).limit(1)`. Passing only `to_province` /
   * `to_locality` throws that answer away: the writer's own soft
   * re-canonicalization then resolves the NAME and lands on the alphabetically
   * first department, so `pets.locality_id` disagreed with the row the person
   * actually tapped and the id at the edge changed nothing the move persisted.
   *
   * `undefined` means "the caller did not resolve" and the writer resolves by
   * name, as it always did. `null` means "the caller resolved and there is no
   * catalogue row", which is an ANSWER and is stored as one — re-resolving it by
   * name here would be the alphabetical guess coming back through the window.
   *
   * Supplying it is a claim that `to_province` / `to_locality` came from the
   * SAME resolution; the writer skips its own canonicalization when it is
   * present, so a caller that mixed sources would store an inconsistent pair.
   */
  resolvedLocalityId?: string | null;
};

export type RecordMovementResult = { ok: true; eventId: string } | { ok: false; error: string };
