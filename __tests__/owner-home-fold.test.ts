// Contract guard for the owner-home fold (owner-ia-redesign P5).
//
// This REPLACES the old inicio-structure.test.ts, which mandated the leaned
// /inicio dashboard (RemindersSection + PetHealthStatusStrip + EventCatcher).
// P5 deleted that dashboard: /inicio is now a server redirect into the
// most-urgent pet, and /mis-mascotas is the index + inbox. Every assertion the
// old test made about the home has a successor here on the surface the function
// actually landed on.
//
// Source-scan style (same as the file it replaces): cheap, no render, no DB —
// catches structural regressions at the import/JSX level.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const inicioSrc = read("app", "(app)", "inicio", "page.tsx");
const indexSrc = read("app", "(app)", "mis-mascotas", "page.tsx");
const casosSrc = read("app", "(app)", "cuenta", "casos", "page.tsx");

// The pet-list QUERY left the page in native-readiness WU-B: `GET
// /api/v1/me/pets` answers the same question, and a route handler with a second
// copy of "which pets are yours" is how the native list eventually shows a pet
// the web list does not. The assertions below follow the code — they check the
// DOOR for the query properties and the PAGE for the call, which together are
// the same guarantee the single source-scan used to make.
const listDoorSrc = read("src", "modules", "pets", "application", "read", "list-owner-pets.ts");

describe("/inicio folds into the profile (decision 7)", () => {
  it("is a server redirect, not a dashboard", () => {
    expect(inicioSrc).toContain("redirect(");
    // No dashboard surfaces remain on the home.
    expect(inicioSrc).not.toContain("<EventCatcher");
    expect(inicioSrc).not.toContain("CredentialRail");
    expect(inicioSrc).not.toContain("PetHealthStatusStrip");
  });

  it("lands on the most-urgent pet using the SAME shared carousel rank", () => {
    expect(inicioSrc).toContain("rankOwnerCarousel");
  });

  it("redirects a zero-live-pet owner to the index+inbox, forwarding the query", () => {
    // The zero-pet branch forwards the same query string the profile branch
    // does, so any OTHER forwarded param (not just ?sheet=anotar) survives the
    // hop. This does NOT mean ?sheet=anotar opens anything here: the bare
    // index doesn't mount SheetMounter, and with zero live pets there is no
    // pet to capture an event against — the index's own "Registrar mascota"
    // CTA is the correct landing for a pets-less owner (W1 review fix bar
    // 2026-07-15 — the prior comment's "fixes the capture sheet for zero-pet
    // owners" claim was false; this only pins the forward+redirect mechanics).
    expect(inicioSrc).toMatch(/redirect\(`\/mis-mascotas\$\{query \? `\?\$\{query\}` : ""\}`\)/);
  });

  it("forwards its searchParams (e.g. ?sheet=anotar) onto the target profile redirect", () => {
    // The tab-bar capture deep-link is /inicio?sheet=anotar; the redirect must
    // carry the query onto the profile so the anotar sheet opens in ONE hop
    // (a bare redirect would land on the pet WITHOUT opening capture).
    expect(inicioSrc).toContain("searchParams");
    expect(inicioSrc).toContain("URLSearchParams");
    // The profile redirect appends the forwarded query string.
    expect(inicioSrc).toMatch(/redirect\(`\/mis-mascotas\/\$\{ranked\[0\]\.token\}\$\{query/);
  });
});

describe("/mis-mascotas is the index + inbox (decisions 3, 4, 6)", () => {
  it("carries the cross-pet rollup (decision 3, §9.1)", () => {
    expect(indexSrc).toContain("<OwnerRollupStrip");
  });

  it("renders the per-pet credential rows as a registry LIST (PO ronda 4 revert from cards)", () => {
    // PO ronda 4 reverted the P5 card grid back to the original list rows. The
    // live-pet entries render as LnRegRow inside an LnRegistry, each linking into
    // its credential; the index+inbox structure around them is unchanged.
    expect(indexSrc).toContain("<LnRegRow");
    expect(indexSrc).toContain("<LnRegistry");
    expect(indexSrc).toContain("/mis-mascotas/${pet.publicToken}");
  });

  it("has an inbox anchored at #inbox (the /cuenta/casos redirect target)", () => {
    expect(indexSrc).toContain('id="inbox"');
  });

  it("shows open workflows AND restores the closed-cases history (§12.9 / P1 orphan)", () => {
    expect(indexSrc).toContain("<CasesWidget");
    expect(indexSrc).toContain("fetchOpenWorkflows");
    expect(indexSrc).toContain("fetchPreviousWorkflows");
  });

  it("surfaces inbound transfers + adoption postulaciones + the resume-application banner", () => {
    expect(indexSrc).toContain("countPendingTransfers");
    expect(indexSrc).toContain("countPendingApplications");
    expect(indexSrc).toContain("<IntentApplyBanner");
  });

  it("has a REAL server-side name search (the 200-cap buscador that never existed)", () => {
    expect(indexSrc).toContain("<PetSearchInput");
    // The page still passes the query down; the predicate itself lives in the
    // door now, so both halves are asserted rather than one.
    expect(indexSrc).toContain("listOwnerPets({ ownerUserId: user.id, query");
    // Raw sql ILIKE predicate with an explicit ESCAPE clause (omnibox parity).
    expect(listDoorSrc).toContain("pets.name} ILIKE");
    expect(listDoorSrc).toContain("ESCAPE");
  });

  it("orders the pet-list query deterministically so the cap isn't DB-order luck", () => {
    // `created_at` alone was NOT deterministic: pets written in one transaction
    // tie exactly, so the key needs a unique tail. The behaviour is pinned
    // against Postgres in `owner-pet-list-order.test.ts`; this is the cheap echo.
    expect(listDoorSrc).toContain(
      "orderBy(desc(pets.createdAt), desc(pets.id), desc(ownerships.id))",
    );
  });

  it("counts the cap notice under the SAME predicate the rows were fetched with", () => {
    // The property that used to be visible as two adjacent queries in the page.
    // Now it is the door's, and it is the thing that makes "mostrando N de M"
    // honest precisely when someone is searching.
    expect(listDoorSrc).toContain("deps.countRows(where)");
    expect(listDoorSrc).toContain("deps.fetchRows(where, limit)");
  });

  it("keeps deceased pets in In memoriam ONLY (decision 6)", () => {
    expect(indexSrc).toContain("In memoriam");
    expect(indexSrc).toContain('pet.status === "deceased"');
  });

  it("points memorial-only search matches at In memoriam, not a bare 'Sin resultados'", () => {
    // When a search matches only deceased pets, the empty state must not claim
    // 'Sin resultados' while the In memoriam section below shows matches (FIX 3).
    expect(indexSrc).toContain("Sin resultados entre tus mascotas activas");
    expect(indexSrc).toContain("Hay coincidencias en In memoriam");
  });

  it("preserves the reclamar entry (index keeps it)", () => {
    expect(indexSrc).toContain("/mis-mascotas/reclamar");
  });

  it("preserves the vet ?as=owner escape hatch (§8 — must survive verbatim)", () => {
    expect(indexSrc).toContain('params.as !== "owner"');
    expect(indexSrc).toContain("resolveVetLanding");
  });
});

describe("/cuenta/casos redirects into the new inbox", () => {
  it("points at /mis-mascotas#inbox (not the transitional /inicio#casos)", () => {
    expect(casosSrc).toContain('redirect("/mis-mascotas#inbox")');
    expect(casosSrc).not.toContain("/inicio#casos");
  });
});
