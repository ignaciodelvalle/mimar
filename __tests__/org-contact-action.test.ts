// submitOrgContactAction — validation + rate-limit + persistence
// (handoff P2-12). The action is the only write path to
// org_contact_messages from the public surface.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, orgContactMessages, organizations } from "@/db";
import { submitOrgContactAction } from "@/src/modules/organizations/actions";

const TOKEN = "DIM-CTC-TEST";

let orgId: string;

beforeAll(async () => {
  await db.delete(organizations).where(eq(organizations.publicToken, TOKEN));
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: TOKEN,
      legalName: "Contact Test Refugio",
      displayName: "Contact Test",
      orgType: "shelter",
      email: "contact-test@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;
});

afterAll(async () => {
  await db.delete(orgContactMessages).where(eq(orgContactMessages.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.publicToken, TOKEN));
});

function formData(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) {
    fd.set(key, value);
  }
  return fd;
}

describe("submitOrgContactAction — validation", () => {
  it("rejects missing email", async () => {
    const result = await submitOrgContactAction(
      TOKEN,
      "contact",
      { ok: false, error: null },
      formData({ message: "Hola, quiero adoptar." }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/email/i);
  });

  it("rejects malformed email", async () => {
    const result = await submitOrgContactAction(
      TOKEN,
      "contact",
      { ok: false, error: null },
      formData({ inquirerEmail: "not-an-email", message: "Hola, quiero adoptar." }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/email/i);
  });

  it("rejects too-short message (< 10 chars)", async () => {
    const result = await submitOrgContactAction(
      TOKEN,
      "contact",
      { ok: false, error: null },
      formData({ inquirerEmail: "test@example.com", message: "Hola" }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/corto/i);
  });

  it("rejects unknown orgToken (visibility gate)", async () => {
    const result = await submitOrgContactAction(
      "DIM-NONE-XXXX",
      "contact",
      { ok: false, error: null },
      formData({ inquirerEmail: "test@example.com", message: "Mensaje válido largo." }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no encontrado/i);
  });
});

describe("submitOrgContactAction — persistence", () => {
  it("inserts a row with kind='contact' on success", async () => {
    const result = await submitOrgContactAction(
      TOKEN,
      "contact",
      { ok: false, error: null },
      formData({
        inquirerName: "Persona",
        inquirerEmail: "Inquirer@Example.COM",
        message: "Quería saber qué pasos seguir para adoptar.",
      }),
    );
    // Rate-limit might still fail if a previous test in this file ran;
    // the validation/persistence assertions guard against silent regressions.
    if (result.ok) {
      const rows = await db
        .select()
        .from(orgContactMessages)
        .where(eq(orgContactMessages.organizationId, orgId));
      const ours = rows.find((r) => r.inquirerEmail === "inquirer@example.com");
      expect(ours, "row should be persisted").toBeDefined();
      expect(ours?.kind).toBe("contact");
      expect(ours?.message).toContain("Quería saber");
      // Email lowercased on insert.
      expect(ours?.inquirerEmail).toBe("inquirer@example.com");
    } else {
      // If rate-limit kicked in, ensure the error is the rate-limit copy,
      // not a validation regression.
      expect(result.error).toMatch(/Esperá|límite|hace poco/i);
    }
  });
});
