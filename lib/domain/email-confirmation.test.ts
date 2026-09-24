import { describe, expect, it } from "vitest";

import { EMAIL_CONFIRMATION_MESSAGES, emailConfirmationProblem } from "./email-confirmation";

describe("emailConfirmationProblem", () => {
  it("accepts the same address typed twice", () => {
    expect(emailConfirmationProblem("ana@muni.gob.ar", "ana@muni.gob.ar")).toBeNull();
  });

  it("ignores case and surrounding blanks — GoTrue stores the address lowercased", () => {
    expect(emailConfirmationProblem(" Ana@Muni.gob.ar ", "ana@muni.GOB.ar")).toBeNull();
  });

  it("refuses a one-letter typo", () => {
    expect(emailConfirmationProblem("ana@muni.gob.ar", "ana@muni.gov.ar")).toBe(
      "Los dos correos no coinciden. Revisalos: el link de acceso se manda a esa dirección.",
    );
  });

  it("refuses an empty confirmation, with its own message", () => {
    expect(emailConfirmationProblem("ana@muni.gob.ar", "   ")).toBe(
      "Escribí el correo de nuevo para confirmarlo.",
    );
    expect(EMAIL_CONFIRMATION_MESSAGES.missing).not.toBe(EMAIL_CONFIRMATION_MESSAGES.mismatch);
  });
});
