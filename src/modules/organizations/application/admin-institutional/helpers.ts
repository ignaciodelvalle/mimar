// Shared DB helpers for admin-institutional use-cases.

import { eq, sql } from "drizzle-orm";

import { db, profiles } from "@/db";
import type { ActorProfile } from "@/lib/domain/institutional-scope";

export async function loadActorProfile(actorUserId: string): Promise<ActorProfile | null> {
  const [row] = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, actorUserId))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    role: row.role as ActorProfile["role"],
    accountType: row.accountType as ActorProfile["accountType"],
    deactivatedAt: row.deactivatedAt,
  };
}

/**
 * Postgres's clock. The first-access arming instant is compared against the
 * `amr` timestamp GoTrue writes, and GoTrue shares a host clock with Postgres —
 * not necessarily with this Node process (a Docker VM drifts from its host).
 * See src/modules/auth/domain/first-access.ts, isSessionAfterArming.
 */
export async function databaseNow(): Promise<Date> {
  const [row] = (await db.execute(sql`SELECT now() AS now`)) as unknown as Array<{
    now: Date | string;
  }>;
  return new Date(row.now);
}
