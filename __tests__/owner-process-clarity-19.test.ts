// Structure guards for owner process-clarity (task #19) — updated for the P5
// fold (owner-ia-redesign).
//
// Task #19's three fixes still ship, but two of them moved off the deleted
// /inicio dashboard onto the /mis-mascotas index (where a pets-less / first-run
// owner and the not-yet-yours cycles now live). This test follows them there:
//   Lens 1 — first-run empty state (was FirstRunEmptyState on /inicio) → the
//            index's own empty state + reclamar entry.
//   Lens 3 — open cycles (applications + transfers) (was OpenCyclesSection on
//            /inicio) → the index's ActionLinkCards.
//   Lens 3 — the lost-pet next steps (was CredCard, the /mis-mascotas index
//            card) → CredCard is DELETED (W1 fix-bar: zero live imports, the
//            index renders LnRegRow rows instead — PO ronda 4 revert). The
//            actual lost quick actions live on the pet PROFILE's lost-case
//            block now (share/poster, mark-found, "ver reporte" IS the
//            profile itself). This block follows them there instead of
//            reading a deleted file that proved nothing.
//
// Source-scan style (same as owner-home-fold.test.ts): cheap, no render, no DB.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const indexSrc = read("app", "(app)", "mis-mascotas", "page.tsx");
const profileSrc = read("app", "(app)", "mis-mascotas", "[publicToken]", "page.tsx");
const lostCaseBlockSrc = read("components", "pet-profile", "LostCaseBlock.tsx");

describe("index — first-run empty state (task #19, Lens 1)", () => {
  it("leads a zero-pet owner with the real first action, not a reassurance", () => {
    expect(indexSrc).toContain("Todavía no registraste ninguna mascota");
    // D.9 (2026-07-30): the CTA is "Registrar mascota" — the one verb for this
    // act on every surface. Asserted INSIDE the empty-state block, because the
    // header CTA carries the same three words now and a bare toContain would
    // pass on the header alone even if this button disappeared.
    const emptyStateBlock = indexSrc.slice(
      indexSrc.indexOf("Todavía no registraste ninguna mascota"),
    );
    expect(emptyStateBlock).toContain("Registrar mascota");
    expect(indexSrc).not.toContain("Cargar una mascota");
  });

  // D.9 (2026-07-30): with one verb everywhere, the header CTA and this box's
  // CTA became the same three words on one screen. The header cedes while the
  // first-run box renders, so the act has exactly one name AND one button.
  it("suppresses the header CTA while the first-run box carries the act", () => {
    expect(indexSrc).toContain(
      "const showFirstRunEmptyState = activePets.length === 0 && !isSearching && !hasAnyOwned;",
    );
    expect(indexSrc).toContain("{!showFirstRunEmptyState && (");
  });

  // D.8 (2026-07-30): the old copy ("No tenés mascotas registradas." / "Cargá
  // una mascota para verla acá.") was circular — it restated the absence and
  // then asked for the act without ever saying what the act GIVES you. The
  // credential is the product, and this is the first screen a pets-less owner
  // sees, so it has to name it. Guarded so a future copy pass can't quietly
  // fall back to a description that only points at the button.
  it("names what the owner gets — the QR-verifiable public credential", () => {
    const emptyStateBlock = indexSrc.slice(
      indexSrc.indexOf("Todavía no registraste ninguna mascota"),
    );
    expect(emptyStateBlock).toContain("credencial digital");
    expect(emptyStateBlock).toMatch(/código QR/);
    expect(emptyStateBlock).toContain("página pública");
    // And it must NOT go back to the circular description.
    expect(indexSrc).not.toContain("Cargá una mascota para verla acá");
  });

  it("keeps the reclamar path reachable for a first-run owner", () => {
    expect(indexSrc).toContain("/mis-mascotas/reclamar");
  });
});

describe("index — open cycles surfaced (task #19, Lens 3)", () => {
  it("fetches both open-cycle counts", () => {
    expect(indexSrc).toContain("countPendingApplications");
    expect(indexSrc).toContain("countPendingTransfers");
  });

  it("renders both as inbox action cards", () => {
    expect(indexSrc).toContain("Mis postulaciones");
    expect(indexSrc).toContain("Transferencias pendientes");
  });
});

describe("pet profile — lost pet next steps (task #19, Lens 3, relocated)", () => {
  it("the profile mounts the lost-case block for a lost pet (the 'ver reporte' surface itself)", () => {
    expect(profileSrc).toContain("<LostCaseBlock");
    expect(lostCaseBlockSrc).toContain('data-section="lost-case-block"');
  });

  it("offers the share/poster affordance linking to the poster route", () => {
    expect(lostCaseBlockSrc).toContain("posterHref");
    expect(lostCaseBlockSrc).toContain("/cartel");
    expect(lostCaseBlockSrc).toContain("LostShareCard");
  });

  it("keeps the mark-found quick action wired to the found sheet", () => {
    expect(lostCaseBlockSrc).toContain("marcar como");
    expect(lostCaseBlockSrc).toContain("?sheet=marcar-encontrada");
  });
});
