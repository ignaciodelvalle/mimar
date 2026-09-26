// Is this user a matriculated vet? The ENO diagnosis step (PO S2) is offered
// only to them — the same gate recordDiseaseDiagnosisAction enforces on the
// server (role = vet AND matrícula verified). Showing the step to anyone else
// would offer a button the server refuses.

import "server-only";

import { eq } from "drizzle-orm";

import { db, profiles } from "@/db";

export async function isVerifiedVet(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: profiles.role, matriculaVerified: profiles.matriculaVerified })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return row?.role === "vet" && row.matriculaVerified === true;
}
