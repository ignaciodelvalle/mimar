import { describe, expect, it } from "vitest";

import { isHiddenTestAccount, isTestAccount } from "./test-accounts";

describe("isTestAccount", () => {
  it("flags genesis cold-start churn (-gen-)", () => {
    expect(isTestAccount("govt-gen-abcd@dim.test")).toBe(true);
    expect(isTestAccount("lucia-gen-9f2@dim.test")).toBe(true);
    expect(isTestAccount("Vet Gen", "vet-gen-xyz@dim.test")).toBe(true);
  });

  it("flags cursor smoke accounts (uc-cd- prefix)", () => {
    expect(isTestAccount("uc-cd-admin")).toBe(true);
    expect(isTestAccount("uc-cd-govt-01")).toBe(true);
  });

  it("flags the dashboard-export fixture", () => {
    expect(isTestAccount("govt-dashboard-export")).toBe(true);
    expect(isTestAccount("Export Bot", "govt-dashboard-export@dim.test")).toBe(true);
  });

  it("flags the plus-addressed bulk-load accounts (staging finding 2026-08-01)", () => {
    // These carry the signup trigger's provisional display_name — the email
    // local part — so the roster was about to show a funcionario
    // "qa-maintainer+cursor-owner2" as a person's name in a national
    // registry. Both identifiers must hit, since the name IS the local part.
    expect(isTestAccount("qa-maintainer+cursor-owner2@example.com")).toBe(true);
    expect(isTestAccount("qa-maintainer+cursor-owner2")).toBe(true);
    expect(isTestAccount("Ana Pérez", "qa-maintainer+cursor-vet1@example.com")).toBe(true);
  });

  it("anchors on the plus-addressing, not on the word 'cursor'", () => {
    // A real organisation could legitimately be named for a cursor; a real
    // titular does not write their own address as somebody else's mailbox plus
    // a routing suffix.
    expect(isTestAccount("Cursor Software SRL", "contacto@cursor.com.ar")).toBe(false);
    expect(isTestAccount("cursor-owner2")).toBe(false);
  });

  it("matches across any of the provided identifiers", () => {
    // name is clean, email is a test handle → still flagged.
    expect(isTestAccount("María González", "maria-gen-1@dim.test")).toBe(true);
  });

  it("does not flag real operators", () => {
    expect(isTestAccount("María González", "maria@intendencia.gob.ar")).toBe(false);
    expect(isTestAccount("Dirección de Zoonosis CABA")).toBe(false);
    // "uc-cd-" only matches as a PREFIX — a substring elsewhere is not a smoke row.
    expect(isTestAccount("Fundación educ-cd")).toBe(false);
  });

  it("ignores null / undefined identifiers", () => {
    expect(isTestAccount(null, undefined)).toBe(false);
    expect(isTestAccount(undefined, "real@example.gob.ar")).toBe(false);
  });
});

describe("isHiddenTestAccount — a roster never hides its reader (RA-6 finding 4)", () => {
  it("never hides the logged-in operator, even on a dead-on test handle", () => {
    // The cold-start case: the FIRST admin of a genesis deployment carries the
    // very churn pattern the filter targets. /admin/admins hid them and then
    // told them "No hay administradores activos".
    expect(
      isHiddenTestAccount({
        isSelf: true,
        displayName: "Admin",
        email: "admin-gen-9f2@dim.test",
      }),
    ).toBe(false);
    expect(isHiddenTestAccount({ isSelf: true, displayName: "uc-cd-admin" })).toBe(false);
  });

  it("still hides everybody else's test accounts", () => {
    expect(
      isHiddenTestAccount({ isSelf: false, displayName: "Govt Gen", email: "govt-gen-a@dim.test" }),
    ).toBe(true);
    // Absent isSelf behaves as "not me".
    expect(isHiddenTestAccount({ displayName: "uc-cd-govt-01" })).toBe(true);
  });

  it("leaves real operators visible regardless of who is reading", () => {
    const maria = { displayName: "María González", email: "maria@intendencia.gob.ar" };
    expect(isHiddenTestAccount({ ...maria, isSelf: true })).toBe(false);
    expect(isHiddenTestAccount({ ...maria, isSelf: false })).toBe(false);
  });
});
