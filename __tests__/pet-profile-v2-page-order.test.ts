// Tests for the pet-profile block ordering (AGENTS.md rule 5 — the Design rules
// intro's "convention 5", whose heading is "### 6. Pet profile order").
//
// REWRITTEN for the "Una sola libreta" redesign (2026-07-04). The credential-
// before-alerts invariant this file has always guarded is unchanged in INTENT
// but has MOVED: page.tsx used to render the identity block itself (behind
// `data-section="hero"`) with the avisos strip as a sibling below it. It no
// longer does. The whole front face is now delegated to `PetDetailTabsPanel`
// via its `credencialContent` prop — a single `<CredentialFace>` element — and
// CredentialFace owns the card's block order internally:
//
//   identity  →  Cumplimiento  →  Avisos (slot)  →  Anotar (slot)
//
// The acts LEFT THE CARD with owner-pet-actions (PO 2026-10-01, "los botones
// salen de la tarjeta"). CredentialFace has no `actions` slot anymore; page.tsx
// hands the primary row (`PetActionRow`) and the grouped panel
// (`PetActionPanel`, the former "⋯ Más") to `PetDetailTabsPanel` as
// `credencialActions`, which draws them AFTER the flip card, on the credencial
// face only:
//
//   flip card  →  PetActionRow (Anotar · Compartir · Modo perdida)  →  PetActionPanel
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
// AGENTS.md rule 5, block order:
//   1. Credencial first (Face 1) — identity/credential is the first content
//      block. No conditional banner precedes it.
//   2. Avisos in one prioritized strip, BELOW the credential (lost leads it).
//   3. The two faces, then the acts below them — the primary row, outside the
//      card, on the credencial face only.
//   4. The former "⋯ Más", shown inline and grouped under the primary row.
//
// This file guards the invariant WHERE IT LIVES:
//   - page.tsx: delegates the front face to PetDetailTabsPanel/CredentialFace
//     and passes PetAlertStrip as the `avisos` slot (not a sibling above the
//     credential); AND the pre-redesign flat v2.1 section names must not
//     resurface (negative guard, unchanged).
//   - CredentialFace.tsx: the card's block order identity → cumplimiento →
//     avisos → anotar, guarded by source position, with no act inside the card.
//   - PetDetailTabsPanel.tsx + page.tsx: the acts render AFTER the flip card,
//     gated to the credencial face, the primary row before the grouped panel.
//     (Render-level twins: PetDetailTabsPanel.interaction.test.tsx and
//     CredentialFace.test.tsx's "acts sit BELOW the credential" block.)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PAGE_TSX = resolve(__dirname, "../app/(app)/mis-mascotas/[publicToken]/page.tsx");
const CREDENTIAL_FACE_TSX = resolve(__dirname, "../components/pet-profile/CredentialFace.tsx");
const TABS_PANEL_TSX = resolve(__dirname, "../components/pet-profile/PetDetailTabsPanel.tsx");

function read(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

/** First source index of `needle`, asserted present. */
function sourceIndex(src: string, needle: string): number {
  const i = src.indexOf(needle);
  expect(i, `expected to find \`${needle}\` in source`).toBeGreaterThanOrEqual(0);
  return i;
}

/**
 * The expression one JSX prop holds (`name={…}`, braces included), cut by brace
 * depth so a guard reads what the prop CARRIES rather than whatever happens to
 * follow it in the file.
 */
function propExpression(src: string, name: string): string {
  const open = sourceIndex(src, `${name}={`) + name.length + 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces after \`${name}={\``);
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
// The acts are not a block of the card since owner-pet-actions — where they
// render now is the "acts below the card" describe at the end of this file.
const CREDENTIAL_BLOCK_ORDER = [
  { name: "identity", marker: 'className="ln-idrow"' },
  { name: "cumplimiento", marker: "<ComplianceObligationsPanel" },
  { name: "avisos", marker: "{avisos && (" },
  { name: "anotar", marker: "{anotar && (" },
] as const;

// Each one, found in CredentialFace.tsx, is an act mounted inside the card again.
const ACTS_INSIDE_THE_CARD = ["<PetActionRow", "<PetActionPanel", "{actions && ("] as const;

// The acts' mount in PetDetailTabsPanel — the gate is part of the marker, so the
// acts leaving the credencial-only condition fails here too.
const ACTS_BELOW_THE_CARD = '{credencialActions && activeFace === "credencial" ? (';

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
  it("renders every block on the card: identity → cumplimiento → avisos → anotar", () => {
    const src = read(CREDENTIAL_FACE_TSX);
    for (const { marker } of CREDENTIAL_BLOCK_ORDER) {
      sourceIndex(src, marker);
    }
  });

  it("mounts no act inside the card — the acts sit below it (owner-pet-actions)", () => {
    const src = read(CREDENTIAL_FACE_TSX);
    for (const act of ACTS_INSIDE_THE_CARD) {
      expect(
        src,
        `\`${act}\` found in CredentialFace.tsx — an act is back inside the card; the acts render below it (rule 5)`,
      ).not.toContain(act);
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

// ---------------------------------------------------------------------------
// owner-pet-actions (PO 2026-10-01) — the acts render BELOW the card, in
// PetDetailTabsPanel, from what page.tsx hands it as `credencialActions`
// ---------------------------------------------------------------------------

describe("the acts below the card — source guard (AGENTS.md rule 5)", () => {
  it("PetDetailTabsPanel draws the flip card first, then the acts — on the credencial face only", () => {
    const src = read(TABS_PANEL_TSX);
    const cardAt = sourceIndex(src, "<FlipCard");
    // The card is the credential: its front face is the CredentialFace node.
    expect(sourceIndex(src, "front={credencialContent}")).toBeGreaterThan(cardAt);
    expect(
      sourceIndex(src, ACTS_BELOW_THE_CARD),
      "the acts appear before <FlipCard — they must sit BELOW the credential, never above it (rule 5)",
    ).toBeGreaterThan(cardAt);
  });

  it("the acts are the card's sibling, not one of its props", () => {
    // FlipCard is self-closing with no JSX in its props, so its first `/>` ends
    // it. Acts handed INTO the card would turn over with it onto the libreta.
    const src = read(TABS_PANEL_TSX);
    const cardAt = sourceIndex(src, "<FlipCard");
    const cardEnd = sourceIndex(src.slice(cardAt), "/>") + cardAt;
    expect(src.slice(cardAt, cardEnd)).not.toContain("credencialActions");
    expect(sourceIndex(src, ACTS_BELOW_THE_CARD)).toBeGreaterThan(cardEnd);
  });

  it("page.tsx hands over the primary row, then the grouped panel — and nothing of the card", () => {
    const page = read(PAGE_TSX);
    // Passed to the panel that draws it below the card…
    expect(sourceIndex(page, "credencialActions={")).toBeGreaterThan(
      sourceIndex(page, "<PetDetailTabsPanel"),
    );
    // …holding the primary row (Anotar · Compartir · Modo perdida) first, then
    // the former "⋯ Más" grouped panel.
    const acts = propExpression(page, "credencialActions");
    expect(
      sourceIndex(acts, "<PetActionRow"),
      "the primary row must lead the acts, above the grouped panel (rule 5)",
    ).toBeLessThan(sourceIndex(acts, "<PetActionPanel"));
    expect(acts).not.toContain("<CredentialFace");
  });
});
