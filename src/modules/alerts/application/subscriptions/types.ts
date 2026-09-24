// Types for alert-subscriptions use-cases.

import { z } from "zod";

import {
  ALERT_DIRECTIONS,
  ALERT_METRIC_KEYS,
  type AlertDirection,
  type AlertMetricKey,
} from "@/db";
import { PROVINCES } from "@/lib/reference/ar-provincias";

// The 24 canonical province display names, DERIVED from the reference catalog —
// never hand-typed. This is the same array `db/migrations/0108_alert_subscriptions.sql`
// generated its `alert_subscriptions_province_valid` CHECK from, and the DDL
// parity block in __tests__/alert-subscriptions.test.ts compares the two
// literal-for-literal, so the Zod gate and the SQL gate cannot drift apart. A
// second hand-written copy would drift silently and the drift would only ever
// surface as a raw SQLSTATE 23514 in front of a user.
const CANONICAL_PROVINCE_NAMES = PROVINCES.map((p) => p.name) as [string, ...string[]];

export const CreateAlertSubscriptionSchema = z.object({
  metricKey: z.enum([...ALERT_METRIC_KEYS] as [AlertMetricKey, ...AlertMetricKey[]]),
  direction: z.enum([...ALERT_DIRECTIONS] as [AlertDirection, ...AlertDirection[]]),
  threshold: z.coerce.number().finite(),
  // P3.2 — this used to be a bare `z.string().min(1)` while its two siblings
  // above were enums, so a non-canonical province ("Cordoba" without the
  // accent, "Provincia de Buenos Aires") walked straight past Zod, hit the DB
  // CHECK, and reached the user as a raw Postgres check_violation instead of a
  // friendly { error }. The DB constraint stays — it is the backstop for any
  // future writer that skips this schema — but it is no longer the FIRST gate.
  jurisdictionProvince: z
    .enum(CANONICAL_PROVINCE_NAMES, {
      error:
        "Provincia no reconocida. Usá el nombre oficial tal cual figura en el listado (por ejemplo «Córdoba», no «Cordoba»).",
    })
    .nullable()
    .optional(),
  jurisdictionLocality: z.string().min(1).nullable().optional(),
  label: z.string().max(120).nullable().optional(),
});

export type CreateAlertSubscriptionInput = z.infer<typeof CreateAlertSubscriptionSchema>;
