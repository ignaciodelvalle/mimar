// Tests for the pet-profile block ordering (AGENTS.md rule 5).
//
// REWRITTEN for the "Una sola libreta" redesign (2026-07-04). The credential-
// before-alerts invariant this file has always guarded is unchanged in INTENT
// but has MOVED: page.tsx used to render the identity block itself (behind
// `data-section="hero"`) with the avisos strip as a sibling below it. It no
// longer does. The whole front face is now delegated to `PetDetailTabsPanel`
// via its `credencialContent` prop — a single `<CredentialFace>` element — and
// CredentialFace owns the block order internally:
//
//   identity  →  Cumplimiento  →  Avisos (slot)  →  Anotar (slot)  →  actions
//
// So `data-section="hero"` is gone from page.tsx, and the prioritized alert
// strip (`PetAlertStrip`) is passed INTO CredentialFace as its `avisos` slot
// (rendered below the identity/compliance, never as a banner above the
// credential). page.tsx itself now carries only `data-section="cases"` (the
// open-cases alert node, built into the `petAlerts` array) and the ORG-only
// `data-section="back-link"` — their SOURCE order no longer mirrors render
// order (the alerts array is assembled above the return), so a page.tsx
// source-order-of-data-sections guard is no longer meaningful.
//
// AGENTS.md rule 5, block order (unchanged doctrine):
//   1. Credencial first (Face 1) — identity/credential is the first content
//      block. No conditional banner precedes it.
//   2. Avisos in one prioritized strip, BELOW the credential (lost leads it).
//   3. Capture (Anotar), then the two-face tabs.
//   4. Everything else lives behind "⋯ Más".
//
// This file now guards the invariant WHERE IT LIVES:
//   - page.tsx: delegates the front face to PetDetailTabsPanel/CredentialFace
//     and passes PetAlertStrip as the `avisos` slot (not a sibling above the
//     credential); AND the pre-redesign flat v2.1 section names must not
//     resurface (negative guard, unchanged).
//   - CredentialFace.tsx: the block order identity → cumplimiento → avisos →
//     anotar → actions, guarded by source position.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PAGE_TSX = resolve(__dirname, "../app/(app)/mis-mascotas/[publicToken]/page.tsx");
const CREDENTIAL_FACE_TSX = resolve(__dirname, "../components/pet-profile/CredentialFace.tsx");

function read(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

/** First source index of `needle`, asserted present. */
function sourceIndex(src: string, needle: string): number {
  const i = src.indexOf(needle);
  expect(i, `expected to find \`${needle}\` in source`).toBeGreaterThanOrEqual(0);
  return i;
}

// Page-level section names from the pre-two-face pet-profile v2.1 flat order.
// None of these belong in page.tsx anymore — the redesign absorbed identity,
// PPP, service-dog, achievements, and the action bar into sub-components. Kept
// as a negative-case regression guard: if any resurface in page.tsx, the flat
// v2.1 structure is creeping back. (Note: some of these names legitimately live
// on markers INSIDE sub-components now — e.g. CredentialFace's own
// `data-section="credentials"` — so this guard is scoped to page.tsx only.)
const OBSOLETE_V21_PAGE_SECTIONS = [
  "current-state",
  "upcoming-care",
  "credentials",
  "ppp-card",
  "service-dog-card",
  "health-timeline",
  "actions-menu",
  "achievements",
] as const;

// CredentialFace's internal block order (AGENTS.md rule 5). Source markers are
// CODE, not comment text, so a reordered comment can't mask a reordered render.
const CREDENTIAL_BLOCK_ORDER = [
  { name: "identity", marker: 'className="ln-idrow"' },
  { name: "cumplimiento", marker: "<ComplianceObligationsPanel" },
  { name: "avisos", marker: "{avisos && (" },
  { name: "anotar", marker: "{anotar && (" },
  { name: "actions", marker: "{actions && (" },
] as const;

// ---------------------------------------------------------------------------
// page.tsx — front face is delegated; alerts go INTO the credential
// ---------------------------------------------------------------------------

describe("pet-profile page.tsx — front-face delegation (AGENTS.md rule 5)", () => {
  it("delegates the front face to PetDetailTabsPanel via a single <CredentialFace>", () => {
    const src = read(PAGE_TSX);
    sourceIndex(src, "<PetDetailTabsPanel");
    sourceIndex(src, "credencialContent={");
    sourceIndex(src, "<CredentialFace");
  });

  it("passes the alert strip as CredentialFace's `avisos` slot — never as a banner above the credential", () => {
    const src = read(PAGE_TSX);
    const credentialFaceAt = sourceIndex(src, "<CredentialFace");
    // Match the JSX usage with its prop, not the `<PetAlertStrip>` mention in
    // the file header comment.
    const alertStripAt = sourceIndex(src, "<PetAlertStrip alerts=");
    const avisosSlotAt = sourceIndex(src, "avisos={");

    // PetAlertStrip is rendered INSIDE the CredentialFace element (as the avisos
    // prop), so it appears after the <CredentialFace opening tag in source —
    // i.e. the alerts sit below the credential, not as a preceding sibling.
    expect(
      alertStripAt,
      "PetAlertStrip appears before <CredentialFace — an alert banner is being rendered ABOVE the credential (rule 5 violation)",
    ).toBeGreaterThan(credentialFaceAt);
    expect(alertStripAt).toBeGreaterThan(avisosSlotAt);
  });

  it('no longer renders the old page-level `data-section="hero"` identity wrapper (moved into CredentialFace)', () => {
    const src = read(PAGE_TSX);
    expect(src).not.toContain('data-section="hero"');
  });

  it("none of the obsolete pet-profile v2.1 flat-order page sections have resurfaced", () => {
    const src = read(PAGE_TSX);
    for (const obsolete of OBSOLETE_V21_PAGE_SECTIONS) {
      expect(
        src,
        `data-section="${obsolete}" found in page.tsx — this is a pre-redesign v2.1 flat section name; the flat structure must not resurface (AGENTS.md rule 5)`,
      ).not.toContain(`data-section="${obsolete}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// tarjeta-todo (PO 2026-07-19) — the profile is ONE thing: the rotating card.
// Nothing below it. The under-card blocks (PetOwnerActivity: nudges /
// Recordatorios / Próximos turnos / Ciclos abiertos) are gone; their unique
// actions moved INTO the card (libreta PRÓXIMO rows).
//
// PO correction (2026-07-18) revises the "nothing above it" half of that
// doctrine: the carousel position dots briefly lived INSIDE the document
// band (tarjeta-todo's dots-in-band placement), but the PO clarified that
// switching between pets is APP-LEVEL navigation, a different layer from the
// credential itself — "no tiene nada que ver la navegación en la app con la
// credencial digital de una mascota." PetSwitcherAvatars now mounts ABOVE the
// card as app chrome (org back-link/notice excepted — org viewers only, and
// now also PetSwitcherAvatars — owners with >1 live pet). See the describe
// block below for the render-order proof.
// ---------------------------------------------------------------------------

describe("tarjeta-todo — the page renders nothing after the card container", () => {
  it("mounts no under-card components: after the document only SheetMounter (invisible, URL-driven) follows", () => {
    const src = read(PAGE_TSX);
    // Slice the RETURN JSX from the card container conditional to the end of
    // the MAIN owner-flow component. The slice ends at the sibling
    // `FormerOwnerCustodyReadOnlyView` function (a SEPARATE render branch — the
    // ex-owner read-only view during a custody episode; its own back-link and
    // banner are that branch's content, NOT under-card surfaces of the owner
    // flow), and the preserved banner helpers below it are alert-strip content
    // mounted INSIDE the card's Avisos slot. PetSwitcherAvatars is deliberately
    // OUTSIDE this slice — it mounts BEFORE `{showCarousel ? (` (above the
    // card); the companion describe block below proves that source position.
    const start = sourceIndex(src, "{showCarousel ? (");
    const end = sourceIndex(src, "function FormerOwnerCustodyReadOnlyView");
    const tail = src.slice(start, end);
    // Every component mounted from the card container onward — the carousel
    // shell wrapping the document, and the invisible sheet mounter. Anything
    // else here is a new under-card surface creeping back.
    const mounted = [...new Set(tail.match(/<[A-Z][A-Za-z0-9]*/g) ?? [])];
    expect(mounted.sort()).toEqual(["<PetCredentialCarousel", "<SheetMounter"]);
  });

  it("the deleted under-card blocks never resurface in page.tsx", () => {
    const src = read(PAGE_TSX);
    for (const gone of ["<PetOwnerActivity", "<RemindersSection", "<CasesWidget", "<LnCard"]) {
      expect(src, `${gone} found in page.tsx — an under-card block returned`).not.toContain(gone);
    }
    expect(src).not.toContain('data-section="pet-owner-activity"');
  });

  it("reminder actions live on the back face: the libreta PRÓXIMO rows carry Posponer/Registrar", () => {
    // Render-level proof lives in FutureLedgerList.test.tsx; this pins the
    // structural chain: LibretaFace mounts FutureLedgerList, and the list
    // wires the SAME server action + canonical reminder URL the deleted
    // under-card blocks used.
    const libretaFace = read(resolve(__dirname, "../components/pet-profile/LibretaFace.tsx"));
    expect(libretaFace).toContain("<FutureLedgerList");
    const ledger = read(resolve(__dirname, "../components/pet-profile/FutureLedgerList.tsx"));
    expect(ledger).toContain("Posponer 7 días");
    expect(ledger).toContain("snoozeReminderAction");
    expect(ledger).toContain("buildReminderVaccineUrl");
  });

  it('no longer renders the deleted "bandDots" slot thread or its DocumentChrome slot', () => {
    // Regression guard for the PO correction: the carousel dots' old home
    // (the document band's bandDots prop thread, page.tsx → PetDetailTabsPanel
    // → FlipCard → DocumentChrome) must not resurface.
    const src = read(PAGE_TSX);
    expect(src).not.toContain("<CarouselBandDots");
    expect(src).not.toContain("bandDots={bandDots}");
    const chrome = read(resolve(__dirname, "../components/pet-profile/DocumentChrome.tsx"));
    expect(chrome).not.toContain('data-section="band-dots"');
    expect(chrome).not.toContain("bandDots");
  });
});

// ---------------------------------------------------------------------------
// PO correction (2026-07-18) — PetSwitcherAvatars (the renamed carousel dots)
// mounts ABOVE the card as its own app-chrome element, gated by the same
// `showCarousel` condition as the swipe shell, never inside the credential.
// ---------------------------------------------------------------------------

describe("PO correction — the multi-pet nav (PetSwitcherAvatars) renders ABOVE the card, as app chrome", () => {
  it("mounts PetSwitcherAvatars, gated by showCarousel, BEFORE the card container in source order", () => {
    const src = read(PAGE_TSX);
    const switcherAt = sourceIndex(src, "{showCarousel && (");
    sourceIndex(src, "<PetSwitcherAvatars");
    const cardAt = sourceIndex(src, "{showCarousel ? (");
    expect(
      switcherAt,
      "PetSwitcherAvatars must mount BEFORE the card container — it is app-level navigation above the credential, not credential content (PO correction 2026-07-18)",
    ).toBeLessThan(cardAt);
  });

  it("PetSwitcherAvatars is a standalone component, not a prop threaded into the credential document", () => {
    const dots = read(resolve(__dirname, "../components/pet-profile/PetSwitcherAvatars.tsx"));
    // The dots group carries its accessible name (the honest-cap disclosure) —
    // pure design on the page, no visible "mostrando N de M" text.
    expect(dots).toContain("aria-label={groupLabel}");
    expect(dots).toContain("mostrando ${total} de ${householdTotal}");
    // It renders as its own <nav>, styled above the card (not the old
    // in-band class).
    expect(dots).toContain("ln-pet-switcher");
    expect(dots).not.toContain("ln-band-dots");
  });

  it("the removed .ln-band-dots CSS rule never resurfaces in globals.css", () => {
    const css = read(resolve(__dirname, "../app/globals.css"));
    // Match the actual selector (a class rule opening), not the historical
    // mention of the removed class name in this file's own migration comment.
    expect(css).not.toMatch(/\.ln-band-dots\s*\{/);
  });
});

// ---------------------------------------------------------------------------
// CredentialFace.tsx — the credential-first block order now lives here
// ---------------------------------------------------------------------------

describe("CredentialFace block order — source guard (AGENTS.md rule 5)", () => {
  it("renders every block: identity → cumplimiento → avisos → anotar → actions", () => {
    const src = read(CREDENTIAL_FACE_TSX);
    for (const { marker } of CREDENTIAL_BLOCK_ORDER) {
      sourceIndex(src, marker);
    }
  });

  it("identity is the FIRST block — no compliance/avisos/anotar precedes it", () => {
    const src = read(CREDENTIAL_FACE_TSX);
    const identityAt = sourceIndex(src, 'className="ln-idrow"');
    for (const { name, marker } of CREDENTIAL_BLOCK_ORDER) {
      if (name === "identity") continue;
      expect(
        sourceIndex(src, marker),
        `\`${marker}\` (${name}) appears before the identity row — the credential must lead (rule 5)`,
      ).toBeGreaterThan(identityAt);
    }
  });

  it("avisos (alerts) come AFTER identity and compliance — below the credential, not above", () => {
    const src = read(CREDENTIAL_FACE_TSX);
    const identityAt = sourceIndex(src, 'className="ln-idrow"');
    const cumplimientoAt = sourceIndex(src, "<ComplianceObligationsPanel");
    const avisosAt = sourceIndex(src, "{avisos && (");
    expect(avisosAt).toBeGreaterThan(identityAt);
    expect(avisosAt).toBeGreaterThan(cumplimientoAt);
  });

  it("the blocks appear in the exact rule-5 order", () => {
    const src = read(CREDENTIAL_FACE_TSX);
    const positions = CREDENTIAL_BLOCK_ORDER.map(({ marker }) => sourceIndex(src, marker));
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });
});
