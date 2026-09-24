// Shared types for the booking application layer.
// Moved verbatim from app/actions/booking.ts (strangler 23/61).

export type BookSlotResult =
  // `redirectTo` is set by the ACTION wrapper (nav contract N3): the writer
  // reports what happened, the action names where the form should go, and the
  // form navigates. The action must not redirect() — that transition is dropped
  // by the App Router in production while the booking commits.
  { ok: true; appointmentToken: string; redirectTo?: string } | { error: string };

export type CancelAppointmentResult = { ok: true } | { error: string };
