// Zod schemas for scheduling system forms. These validate user-facing input
// (server action arguments) — NOT event payloads, which live in lib/event-schemas.ts.

import { z } from "zod";

export const CreateServiceOfferingInput = z.object({
  serviceKind: z.string().min(1),
  displayName: z.string().min(3).max(120),
  description: z.string().max(500).nullable(),
  durationMinutes: z.number().int().min(5).max(480),
  slotCapacity: z.number().int().min(1).max(100),
  priceArs: z.number().nonnegative().nullable(),
  eligibilitySpecies: z.array(z.enum(["dog", "cat"])).nullable(),
  eligibilityAgeMinMonths: z.number().int().min(0).max(360).nullable(),
  eligibilityAgeMaxMonths: z.number().int().min(0).max(360).nullable(),
});

export type CreateServiceOfferingInputType = z.infer<typeof CreateServiceOfferingInput>;

// ── Schedule rule schemas (Fase 2) ──────────────────────────────────────────
// Align with service_schedule_rules columns in db/schema.ts.
// daysOfWeek: ISO 8601 weekday numbers (1=Monday … 7=Sunday).
// startTimeLocal / endTimeLocal: HH:MM (24-hour, local to the tz).
// effectiveFrom / effectiveUntil: YYYY-MM-DD date strings.

export const CreateScheduleRuleInput = z
  .object({
    serviceOfferingId: z.string().uuid(),
    daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1),
    startTimeLocal: z.string().regex(/^\d{2}:\d{2}$/),
    endTimeLocal: z.string().regex(/^\d{2}:\d{2}$/),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    effectiveUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  })
  .refine((d) => d.endTimeLocal > d.startTimeLocal, {
    message: "La hora de fin debe ser posterior a la hora de inicio",
  });

export type CreateScheduleRuleInputType = z.infer<typeof CreateScheduleRuleInput>;

// Partial update: only the time/day fields can change (offering_id is immutable
// on an existing rule; status is mutated via the delete action).
export const UpdateScheduleRuleInput = z
  .object({
    daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).optional(),
    startTimeLocal: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    endTimeLocal: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    effectiveFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    effectiveUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  })
  .refine(
    (d) => {
      if (d.startTimeLocal && d.endTimeLocal) return d.endTimeLocal > d.startTimeLocal;
      return true;
    },
    { message: "La hora de fin debe ser posterior a la hora de inicio" },
  );

export type UpdateScheduleRuleInputType = z.infer<typeof UpdateScheduleRuleInput>;

// Soft-delete: sets status='archived'. ruleId is validated in the action layer.
export const DeleteScheduleRuleInput = z.object({
  ruleId: z.string().uuid(),
});

export const BookSlotInput = z.object({
  slotId: z.string().uuid(),
  petPublicToken: z.string().min(1),
  notesFromOwner: z.string().max(500).nullable(),
});

export const MarkAttendedInput = z.object({
  appointmentPublicToken: z.string().min(1),
  // Service-kind-specific fields are validated separately at action time.
});
