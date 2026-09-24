// `MyAppointmentsV1`, built from what `listAppointmentsForUser` already decided.
//
// THIS FILE DECIDES NOTHING. Which section a row is in, whether it can still be
// cancelled, whether its check-in QR is still good — all three were settled by
// the use-case against the server's clock, which is the entire reason they are on
// the wire at all. What is left here is serialisation: `Date` to ISO, a flat row
// to the contract's nesting.
//
// That separation is what stops this endpoint from becoming a THIRD copy of the
// bucketing rule. The web's page has it inline, the use-case has it once, and if
// this file recomputed even `section` from `status` the two doors would disagree
// about a turno the moment its slot time passed — which is exactly the window
// where a person is looking at the screen.
//
// NO OWNER NOTES CROSS THIS BOUNDARY, and there is nothing to filter: the
// use-case never selects `appointments.notes_from_owner` or `notes_from_org`.
// Both are plaintext columns the Ley 25.326 fence named, and the web's own detail
// page renders neither — so withholding them here is parity, not a gap.

import { apiV1Envelope } from "@/lib/infra/api-v1";
import type {
  AppointmentListItem,
  AppointmentsForUser,
} from "@/src/modules/events/application/booking/list-appointments-for-user";
import {
  MY_APPOINTMENTS_PAYLOAD_VERSION,
  MY_APPOINTMENTS_STALE_AFTER_MS,
  type MyAppointmentV1,
  type MyAppointmentsV1,
} from "@dim/contract/api";

function toAppointmentV1(item: AppointmentListItem): MyAppointmentV1 {
  return {
    appointmentToken: item.appointmentToken,
    status: item.status,
    section: item.section,
    pet: { publicToken: item.pet.publicToken, name: item.pet.name },
    offeringName: item.offeringName,
    serviceKind: item.serviceKind,
    serviceKindLabel: item.serviceKindLabel,
    provider: item.provider,
    durationMinutes: item.durationMinutes,
    priceArs: item.priceArs,
    startsAt: item.startsAt.toISOString(),
    endsAt: item.endsAt.toISOString(),
    capabilities: {
      canCancel: item.canCancel,
      canCheckIn: item.canCheckIn,
    },
  };
}

export function buildMyAppointmentsV1(input: {
  appointments: AppointmentsForUser;
  now: Date;
}): MyAppointmentsV1 {
  return {
    // THE SHARED ENVELOPE, not three fields spelled out here. §6 requires
    // `payloadVersion` / `issuedAt` / `staleAfter` on every read, and a payload
    // that composed its own would be one more place the shape could drift.
    ...apiV1Envelope({
      payloadVersion: MY_APPOINTMENTS_PAYLOAD_VERSION,
      issuedAt: input.now,
      staleAfterMs: MY_APPOINTMENTS_STALE_AFTER_MS,
    }),
    upcoming: input.appointments.upcoming.map(toAppointmentV1),
    past: input.appointments.past.map(toAppointmentV1),
    cancelled: input.appointments.cancelled.map(toAppointmentV1),
  };
}
