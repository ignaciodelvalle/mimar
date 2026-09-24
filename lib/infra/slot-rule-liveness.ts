// slotRuleIsLive — is the schedule rule that materialised a time slot still
// in force for that slot's date? (T1-L16)
//
// Slots are materialised 60 days ahead from `service_schedule_rules`. Deleting
// a rule only archives it (delete-schedule-rule.ts), and editing its window
// only rewrites `effective_from` / `effective_until` — neither touched the
// slots already materialised, and `bookSlotWriter` re-checked the slot's
// status, capacity, future window and offering, never the rule. So a clinic
// that deleted its Monday agenda kept taking Monday bookings for two months.
//
// This predicate is the one definition of "the slot's rule still stands":
//   - a slot with no rule (`rule_id` NULL — the rule was hard-deleted, or the
//     slot was created by hand) is judged by the other gates alone, as before;
//   - otherwise the rule must be `active` AND the slot's LOCAL date (in the
//     rule's own timezone, the one it was materialised in) must fall inside
//     [effective_from, effective_until].
//
// It is used in THREE places that must agree, so it lives here and not in any
// one of them:
//   - bookSlotWriter, inside the slot's advisory lock — the authority;
//   - every read that lists bookable slots — so the UI never advertises a slot
//     the writer refuses (the same pairing the offering-status gate has);
//   - the materialiser's ON CONFLICT clause — a REPLACEMENT rule covering the
//     same times adopts the stale slot instead of being silently blocked by
//     the (service_offering_id, starts_at) unique index.
//
// Already-booked appointments are untouched by construction: nothing here
// writes to a slot or an appointment; it only decides whether a NEW booking
// may be taken.
//
// Column references are qualified with the `time_slots` table name, so the
// predicate is valid in any statement where `time_slots` is in scope unaliased
// (a SELECT FROM time_slots, or the ON CONFLICT DO UPDATE of an insert into it,
// where the existing row is addressed by the table name).

import { type SQL, sql } from "drizzle-orm";

import { timeSlots } from "@/db/schema";

export function slotRuleIsLive(): SQL {
  // One line on purpose: it is compiled into queries whose SQL text is pinned
  // by tests (search-bookable-slots.test.ts), and a single line reads there.
  const localDate = sql`(${timeSlots.startsAt} at time zone ssr.timezone)::date`;
  return sql`(${timeSlots.ruleId} is null or exists (select 1 from service_schedule_rules ssr where ssr.id = ${timeSlots.ruleId} and ssr.status = 'active' and ${localDate} >= ssr.effective_from and (ssr.effective_until is null or ${localDate} <= ssr.effective_until)))`;
}
