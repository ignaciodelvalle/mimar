// `AppointmentSearchV1` and `BookableOfferingDetailV1`, built from what the
// use-cases already decided.
//
// THIS FILE DECIDES NOTHING, which is the same rule `me/appointments/payload.ts`
// states and the reason both exist. Which offerings match, which slots are
// takeable, which pets may be booked and whether one of them already holds a
// place in this campaign — all four were settled in
// `search-bookable-slots.ts` against the server's clock and the caller's session.
// What is left here is serialisation: `Date` to ISO, a domain shape to the
// contract's.
//
// THE ONE THING IT DOES DECIDE IS THE CATALOGUE'S ORDER, and only because
// `SERVICE_KINDS` is already an ordered list — it is carried across unchanged
// rather than sorted, so the phone's picker and the web's show the same twelve
// rows in the same sequence.

import { apiV1Envelope } from "@/lib/infra/api-v1";
import { SERVICE_KINDS } from "@/lib/reference/service-kinds";
import type {
  BookableOfferingDetail,
  BookableOfferingSummary,
  BookablePet,
  BookableSlot,
} from "@/src/modules/events/application/booking/search-bookable-slots";
import {
  APPOINTMENT_OFFERING_WINDOW_DAYS,
  APPOINTMENT_SEARCH_LIST_WINDOW_DAYS,
  APPOINTMENT_SEARCH_PAYLOAD_VERSION,
  APPOINTMENT_SEARCH_STALE_AFTER_MS,
  type AppointmentSearchV1,
  type BookableOfferingDetailV1,
  type BookableOfferingV1,
  type BookablePetV1,
  type BookableSlotV1,
  type ServiceKindOptionV1,
} from "@dim/contract/api";

/**
 * The whole catalogue, on EVERY search response.
 *
 * TWELVE SHORT PAIRS, and carrying them unconditionally is cheaper than the
 * alternative: a client that fetched the picker once and cached it would print a
 * stale label the day a kind is added, and a second endpoint for a constant is a
 * route, a bucket and a payload version for ~400 bytes.
 */
function serviceKindOptions(): ServiceKindOptionV1[] {
  return SERVICE_KINDS.map((kind) => ({ code: kind.code, label: kind.label }));
}

function toOfferingV1(offering: BookableOfferingSummary): BookableOfferingV1 {
  return {
    offeringToken: offering.offeringToken,
    displayName: offering.displayName,
    description: offering.description,
    serviceKind: offering.serviceKind,
    serviceKindLabel: offering.serviceKindLabel,
    provider: offering.provider,
    durationMinutes: offering.durationMinutes,
    priceArs: offering.priceArs,
    coverageLabel: offering.coverageLabel,
    slotsInWindow: offering.slotsInWindow,
    nextSlotAt: offering.nextSlotAt.toISOString(),
  };
}

function toSlotV1(slot: BookableSlot): BookableSlotV1 {
  return {
    slotId: slot.slotId,
    startsAt: slot.startsAt.toISOString(),
    endsAt: slot.endsAt.toISOString(),
    placesLeft: slot.placesLeft,
  };
}

function toPetV1(pet: BookablePet): BookablePetV1 {
  return {
    publicToken: pet.publicToken,
    name: pet.name,
    canBook: pet.canBook,
    blockedReason: pet.blockedReason,
  };
}

export function buildAppointmentSearchV1(input: {
  serviceKind: string | null;
  appliedProvince: string | null;
  appliedLocality: string | null;
  jurisdictionSource: AppointmentSearchV1["jurisdictionSource"];
  results: BookableOfferingSummary[];
  now: Date;
}): AppointmentSearchV1 {
  return {
    // THE SHARED ENVELOPE, not three fields spelled out here — §6 requires all
    // three on every read and a payload that composed its own would be one more
    // place the shape could drift.
    ...apiV1Envelope({
      payloadVersion: APPOINTMENT_SEARCH_PAYLOAD_VERSION,
      issuedAt: input.now,
      staleAfterMs: APPOINTMENT_SEARCH_STALE_AFTER_MS,
    }),
    serviceKinds: serviceKindOptions(),
    serviceKind: input.serviceKind,
    appliedProvince: input.appliedProvince,
    appliedLocality: input.appliedLocality,
    jurisdictionSource: input.jurisdictionSource,
    results: input.results.map(toOfferingV1),
    windowDays: APPOINTMENT_SEARCH_LIST_WINDOW_DAYS,
  };
}

export function buildBookableOfferingDetailV1(input: {
  detail: BookableOfferingDetail;
  now: Date;
}): BookableOfferingDetailV1 {
  return {
    ...apiV1Envelope({
      payloadVersion: APPOINTMENT_SEARCH_PAYLOAD_VERSION,
      issuedAt: input.now,
      staleAfterMs: APPOINTMENT_SEARCH_STALE_AFTER_MS,
    }),
    offering: toOfferingV1(input.detail.offering),
    slots: input.detail.slots.map(toSlotV1),
    pets: input.detail.pets.map(toPetV1),
    windowDays: APPOINTMENT_OFFERING_WINDOW_DAYS,
  };
}
