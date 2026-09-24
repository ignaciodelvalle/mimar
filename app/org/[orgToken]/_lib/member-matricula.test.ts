// D-9 (Lote D) — the acting member's matrícula, as a status instead of prose.
//
// The gap this closes: the only mention of matrícula anywhere on the org landing
// was a conditional clause inside the "Atender" card ("Si tenés matrícula
// verificada, se firma como verificado por profesional"). A conditional never
// tells the reader which side of it they are on, so a vet who never submitted a
// licence and one whose submission is queued for approval read the page
// identically — and both find out only after signing an event that does not
// count as professionally verified.

import { describe, expect, it } from "vitest";

import { deriveMatriculaStatus } from "./member-matricula";

describe("deriveMatriculaStatus — three states, never two", () => {
  it("verified: shows the number and says signatures carry professional weight", () => {
    const status = deriveMatriculaStatus({ matriculaNumber: "MP 1234", matriculaVerified: true });
    expect(status.state).toBe("verified");
    expect(status.tone).toBe("ok");
    expect(status.label).toContain("MP 1234");
    expect(status.detail).toContain("verificados por profesional");
    // Nothing to do — offering an action here would send a verified vet to a
    // form they already completed.
    expect(status.href).toBeUndefined();
  });

  it("pending: submitted but unapproved is its OWN state, not 'verified' and not 'missing'", () => {
    const status = deriveMatriculaStatus({ matriculaNumber: "MP 1234", matriculaVerified: false });
    expect(status.state).toBe("pending");
    expect(status.tone).toBe("open");
    expect(status.detail).toContain("esperando aprobación");
    // Waiting on an admin decision — no CTA, the vet has already acted.
    expect(status.href).toBeUndefined();
  });

  it("missing: no licence at all is the only actionable state, and it gets the link", () => {
    const status = deriveMatriculaStatus({ matriculaNumber: null, matriculaVerified: false });
    expect(status.state).toBe("missing");
    expect(status.href).toBe("/cuenta/upgrade");
    expect(status.detail).toContain("declarados");
  });

  it("a whitespace-only matrícula is missing, not pending — it promises no review", () => {
    expect(deriveMatriculaStatus({ matriculaNumber: "   ", matriculaVerified: false }).state).toBe(
      "missing",
    );
  });

  it("a verified flag with no number never renders a licence badge with nothing in it", () => {
    const status = deriveMatriculaStatus({ matriculaNumber: null, matriculaVerified: true });
    expect(status.state).toBe("missing");
    expect(status.label).not.toContain("verificada");
  });

  it("every state carries a consequence sentence, not just a restatement of itself", () => {
    for (const input of [
      { matriculaNumber: "MP 1", matriculaVerified: true },
      { matriculaNumber: "MP 1", matriculaVerified: false },
      { matriculaNumber: null, matriculaVerified: false },
    ]) {
      expect(deriveMatriculaStatus(input).detail.length).toBeGreaterThan(30);
    }
  });
});
