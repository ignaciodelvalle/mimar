// Give notification rows their ids BEFORE they are inserted
// (notificaciones-destinos review R3, 2026-10).
//
// Every push now carries `notificationId`, so the tap can ask the server where
// to go at tap time. The service path (`createNotification*`) gets the id back
// from its INSERT … RETURNING. The legacy direct-insert sites (baselined in
// scripts/notifications-service-baseline.json) insert a `pending` array and
// then push the same array; minting the uuid here, once, makes the id the row
// is stored under and the id the push carries the same value by construction —
// no positional zip of RETURNING rows, no second read.
//
// A row that already carries an id keeps it.

import { randomUUID } from "node:crypto";

export function withNotificationIds<T extends object>(
  rows: readonly T[],
): Array<T & { id: string }> {
  return rows.map((row) => {
    const existing = (row as { id?: unknown }).id;
    return {
      ...row,
      id: typeof existing === "string" && existing !== "" ? existing : randomUUID(),
    };
  });
}
