// The place queue's form lives ON /admin/localidades/pendientes and leaves it
// by a full document navigation. The action therefore must not revalidate that
// page: the re-render rode the action response while the resolved row had just
// left the queue, and the admin saw the segment error boundary flash before
// the navigation landed (PO report, staging 2026-10-06).
import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrRedirect: vi.fn(async () => ({ user: { id: "admin-1" } })),
  requireAdministrationPrincipalOrRedirect: vi.fn(),
}));
vi.mock("@/lib/place/resolution-rerouting", () => ({
  retargetPendingOutbox: vi.fn(async () => undefined),
  notifyNewlyCoveringAuthorities: vi.fn(async () => undefined),
}));
vi.mock("@/lib/place/unresolved-queue", () => ({
  resolvePlaceFromQueue: vi.fn(async () => ({ ok: true })),
}));

import { resolvePlaceFromQueueAction } from "@/app/actions/authority-units";
import { resolvedPlaceUrl } from "@/app/admin/localidades/_components/resolved-place-url";

describe("resolvePlaceFromQueueAction", () => {
  beforeEach(() => revalidatePath.mockClear());

  it("succeeds without revalidating the page the form is on", async () => {
    const r = await resolvePlaceFromQueueAction({
      subjectTable: "cases",
      subjectId: "00000000-0000-4000-8000-000000000001",
      localityId: "00000000-0000-4000-8000-000000000002",
      reason: "es esa",
    });
    expect(r).toEqual({ ok: true });
    expect(revalidatePath).not.toHaveBeenCalledWith("/admin/localidades/pendientes");
  });

  it("lands on the queue carrying the resolved locality for the confirmation", () => {
    expect(resolvedPlaceUrl("AR-B", { name: "San Martín", department: "General San Martín" })).toBe(
      "/admin/localidades/pendientes?provincia=AR-B&resuelto=San+Mart%C3%ADn+%28General+San+Mart%C3%ADn%29",
    );
    expect(resolvedPlaceUrl("AR-B", undefined)).toBe(
      "/admin/localidades/pendientes?provincia=AR-B",
    );
  });
});
