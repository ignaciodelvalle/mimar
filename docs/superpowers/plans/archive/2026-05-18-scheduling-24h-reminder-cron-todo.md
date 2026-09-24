# TODO: 24h appointment reminder cron

> Deferred from Fase 10 of the health-campaigns-and-scheduling epic.
> Scheduling infrastructure (Vercel Cron / external scheduler) is not yet configured.

## What needs to be built

A daily cron job (recommended: 09:00 local time, `America/Argentina/Buenos_Aires`) that sends
24-hour advance notifications to pet owners with upcoming confirmed appointments.

## Query

```sql
-- Find confirmed appointments that start between now and now+24h
-- AND have not yet received a 24h reminder notification.
SELECT a.id, a.public_token, a.owner_user_id, a.pet_id,
       s.starts_at, o.display_name AS offering_name
FROM appointments a
JOIN time_slots s ON s.id = a.slot_id
JOIN service_offerings o ON o.id = a.service_offering_id
WHERE a.status = 'confirmed'
  AND s.starts_at BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
  AND NOT EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.user_id = a.owner_user_id
      AND n.notification_type = 'appointment_reminder_24h'
      AND n.cta_url = '/mis-turnos/' || a.public_token
  );
```

## Action per row

Insert one `notifications` row:

```ts
{
  userId: appointment.ownerUserId,
  notificationType: "appointment_reminder_24h",
  title: `Recordatorio: turno mañana`,
  body: `Tenés un turno de "${offeringName}" mañana a las ${startsAt.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}.`,
  severity: "info",
  ctaLabel: "Ver turno",
  ctaUrl: `/mis-turnos/${appointment.publicToken}`,
}
```

## Implementation path

1. Add `"appointment_reminder_24h"` to the `notification_type` CHECK constraint
   (or keep it as a free-text type — the constraint is TEXT with no enum restriction).
2. Create `app/api/cron/appointment-reminders/route.ts` following the same pattern
   as `app/api/cron/materialize-slots/route.ts` (secret-gated GET handler).
3. Configure in `vercel.json`:
   ```json
   {
     "crons": [
       { "path": "/api/cron/appointment-reminders", "schedule": "0 12 * * *" }
     ]
   }
   ```
   (12:00 UTC = 09:00 ART)

## Why deferred

Vercel Cron is only available on paid plans. The route itself is trivial once the
scheduler is provisioned. No schema changes are required.
