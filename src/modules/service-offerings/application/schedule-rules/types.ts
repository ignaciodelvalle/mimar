// Shared types for the schedule-rules application layer.
// Moved verbatim from app/actions/schedule-rules.ts (strangler 24/61).

export type ScheduleRuleResult = { error: string } | { ok: true };
export type ScheduleRuleFormState = { error: string | null };
