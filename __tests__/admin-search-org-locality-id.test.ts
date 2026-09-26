// The org directory hands each organization's catalogue row to its revoke
// control (security review, localidades-por-id).
//
// RevokeOrgActions decides whether to show "Revocar verificación" with the
// same per-row gate the server uses; on the id path a unit grant compares
// catalogue rows, so the directory must carry organizations.locality_id or a
// homonym's org would show (or hide) the control by its name alone. The
// server re-checks either way. Read-only.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, organizations } from "@/db";
import { searchOrganizations } from "@/lib/infra/admin-search";

describe("searchOrganizations", () => {
  it("returns each organization's catalogue row", async () => {
    const [org] = await db
      .select({
        id: organizations.id,
        displayName: organizations.displayName,
        localityId: organizations.localityId,
      })
      .from(organizations)
      .where(eq(organizations.status, "active"))
      .limit(1);
    expect(org, "an organization must exist (seed)").toBeTruthy();
    const { items } = await searchOrganizations(org?.displayName ?? "", {
      role: "admin",
      jurisdictions: [],
    });
    const found = items.find((i) => i.id === org?.id);
    expect(found).toBeTruthy();
    expect(found).toHaveProperty("localityId", org?.localityId ?? null);
  });
});
