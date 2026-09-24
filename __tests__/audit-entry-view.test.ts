// Unit tests for lib/audit-entry-view.ts and lib/audit-target-link.ts.
//
// Pure helpers — no DB, no Next.js runtime.
// Covers C11 (describeAuditEntry) and C12 (deriveTargetHref / buildTargetLinkInfo).

import { describe, expect, it } from "vitest";

import { describeAuditEntry } from "@/lib/ui/audit-entry-view";
import { buildTargetLinkInfo, deriveTargetHref } from "@/lib/ui/audit-target-link";

// ============================================================================
// describeAuditEntry
// ============================================================================

describe("describeAuditEntry — label mapping", () => {
  it("maps known action to human label", () => {
    const view = describeAuditEntry("admin_deactivated_by_admin", {});
    expect(view.label).toBe("Desactivación cuenta admin (por admin)");
  });

  it("falls back to raw action code for unknown action", () => {
    const view = describeAuditEntry("some_unknown_action_xyz", {});
    expect(view.label).toBe("some_unknown_action_xyz");
  });
});

describe("describeAuditEntry — reason extraction", () => {
  it("extracts reason from payload", () => {
    const view = describeAuditEntry("govt_deactivated_by_admin", {
      reason: "Incumplimiento de protocolo",
      evidence_attachment_ids: [],
    });
    expect(view.reason).toBe("Incumplimiento de protocolo");
  });

  it("trims whitespace from reason", () => {
    const view = describeAuditEntry("govt_deactivated_by_admin", {
      reason: "  Motivo con espacios  ",
    });
    expect(view.reason).toBe("Motivo con espacios");
  });

  it("omits reason when absent", () => {
    const view = describeAuditEntry("govt_locality_assigned", {
      province: "Buenos Aires",
      locality: "La Plata",
    });
    expect(view.reason).toBeUndefined();
  });

  it("omits reason when empty string", () => {
    const view = describeAuditEntry("admin_deactivated_by_admin", { reason: "   " });
    expect(view.reason).toBeUndefined();
  });
});

describe("describeAuditEntry — evidence count", () => {
  it("counts evidence attachment ids", () => {
    const view = describeAuditEntry("admin_deactivated_by_admin", {
      reason: "Fraude documentado",
      evidence_attachment_ids: ["id-1", "id-2", "id-3"],
    });
    expect(view.evidenceCount).toBe(3);
  });

  it("omits evidenceCount for empty array", () => {
    const view = describeAuditEntry("admin_deactivated_by_admin", {
      reason: "Motivo",
      evidence_attachment_ids: [],
    });
    expect(view.evidenceCount).toBeUndefined();
  });

  it("omits evidenceCount when field absent", () => {
    const view = describeAuditEntry("admin_deactivated_by_admin", { reason: "Motivo" });
    expect(view.evidenceCount).toBeUndefined();
  });
});

describe("describeAuditEntry — operator_credentials_reset PII safety", () => {
  it("NEVER exposes the magic_link URL (token) in the view", () => {
    const payload = {
      method: "magic_link",
      magic_link: "https://example.supabase.co/auth/v1/verify?token=super-secret",
    };
    const view = describeAuditEntry("operator_credentials_reset", payload);
    // The view must not contain the secret token or the raw URL
    expect(JSON.stringify(view)).not.toContain("super-secret");
    expect(JSON.stringify(view)).not.toContain("supabase.co");
    // The raw payload field key "magic_link" must not appear as a view property key
    expect(Object.keys(view)).not.toContain("magic_link");
  });

  it("surfaces reset method but not the link itself", () => {
    const view = describeAuditEntry("operator_credentials_reset", {
      method: "magic_link",
      magic_link: "https://example.supabase.co/auth/v1/verify?token=abc123",
    });
    expect(view.resetMethod).toBe("magic_link");
    expect((view as unknown as Record<string, unknown>).magic_link).toBeUndefined();
  });

  it("does not expose magic_link even for unrelated actions", () => {
    // Defensive: if some other action had a magic_link field, it should NOT surface it
    const view = describeAuditEntry("institutional_admin_created", {
      magic_link: "https://example.com/leaked",
    });
    expect(JSON.stringify(view)).not.toContain("leaked");
    expect(view.resetMethod).toBeUndefined();
  });
});

describe("describeAuditEntry — non-object payloads", () => {
  it("handles null payload gracefully", () => {
    const view = describeAuditEntry("admin_deactivated_by_admin", null);
    expect(view.label).toBe("Desactivación cuenta admin (por admin)");
    expect(view.reason).toBeUndefined();
    expect(view.evidenceCount).toBeUndefined();
  });

  it("handles string payload gracefully", () => {
    const view = describeAuditEntry("admin_deactivated_by_admin", "raw string");
    expect(view.label).toBeDefined();
    expect(view.reason).toBeUndefined();
  });

  it("handles array payload gracefully", () => {
    const view = describeAuditEntry("admin_deactivated_by_admin", [1, 2, 3]);
    expect(view.label).toBeDefined();
    expect(view.reason).toBeUndefined();
  });
});

// ============================================================================
// deriveTargetHref
// ============================================================================

describe("deriveTargetHref", () => {
  const id = "00000000-0000-0000-0000-000000000001";

  it("links admin role to /admin/admins/:id", () => {
    expect(deriveTargetHref(id, "admin")).toBe(`/admin/admins/${id}`);
  });

  it("links govt role to /admin/govts/:id", () => {
    expect(deriveTargetHref(id, "govt")).toBe(`/admin/govts/${id}`);
  });

  it("returns null for owner role", () => {
    expect(deriveTargetHref(id, "owner")).toBeNull();
  });

  it("returns null for vet role", () => {
    expect(deriveTargetHref(id, "vet")).toBeNull();
  });

  it("returns null for unknown role", () => {
    expect(deriveTargetHref(id, "some_future_role")).toBeNull();
  });
});

describe("buildTargetLinkInfo", () => {
  const id = "00000000-0000-0000-0000-000000000002";

  it("returns correct href and displayName for admin", () => {
    const info = buildTargetLinkInfo({ id, displayName: "Test Admin", role: "admin" });
    expect(info.href).toBe(`/admin/admins/${id}`);
    expect(info.displayName).toBe("Test Admin");
    expect(info.id).toBe(id);
  });

  it("returns correct href and displayName for govt", () => {
    const info = buildTargetLinkInfo({ id, displayName: "Test Govt", role: "govt" });
    expect(info.href).toBe(`/admin/govts/${id}`);
  });

  it("returns null href for non-institutional role", () => {
    const info = buildTargetLinkInfo({ id, displayName: "Owner User", role: "owner" });
    expect(info.href).toBeNull();
    expect(info.displayName).toBe("Owner User");
  });
});
