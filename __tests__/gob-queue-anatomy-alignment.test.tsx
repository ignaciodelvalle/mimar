// gob-queue-anatomy-alignment.test.tsx — A5 (2026-07-30).
//
// The six operator queues were measured and five distinct row anatomies were
// found. The dominant one — components/ui/dashboard/CaseQueue.tsx, used by 4
// operator surfaces and the only one already living in a shared component —
// renders every identifier through the OpCodeBadge atom, every state through
// the OpStatusPill primitive, and every date through the absolute `formatDate`.
//
// The decision was to adopt those ATOMS inside each queue's EXISTING card, not
// to force card-based queues into a <table> (Pérdidas and Aprobaciones have
// inline actions and bulk checkboxes a table would break).
//
// This file covers the two card queues that can be rendered standalone:
//   • Pérdidas     — app/gob/perdidas/_components/LostPetRow.tsx
//   • Aprobaciones — components/BulkApprovalQueueList.tsx
//
// Denuncias·Triage is covered in app/gob/maltrato/_components/
// WelfareDenunciaRow.test.tsx and Decomisos in app/gob/decomisos/__tests__/
// decomisos-code-badge.test.tsx (that one is a page and needs the db mock).
//
// Expected badge markup is READ FROM the atoms themselves rather than
// hardcoded, so these tests pin "goes through the shared atom" instead of a
// class list that would drift the moment the atom is restyled.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

import { LostPetRow } from "@/app/gob/perdidas/_components/LostPetRow";
import { BulkApprovalQueueList } from "@/components/BulkApprovalQueueList";
import { OpCodeBadge } from "@/components/ui/dashboard/OpCodeBadge";
import { formatDate, formatDateShort } from "@/lib/utils/format";

/** The exact markup the shared atom produces for a given code + tone. */
function codeBadgeMarkup(tone: "blue" | "neutral", code: string): string {
  return renderToStaticMarkup(<OpCodeBadge tone={tone}>{code}</OpCodeBadge>);
}

// ---------------------------------------------------------------------------
// Pérdidas — LostPetRow
// ---------------------------------------------------------------------------

const MARKED_LOST_AT = new Date("2026-07-01T12:00:00Z");

const LOST_PET = {
  petId: "pet-1",
  petPublicToken: "DIM-GOBT-0001",
  petName: "Firulais",
  species: "dog",
  petStatus: "lost",
  province: "Buenos Aires",
  locality: "La Plata",
  markedLostAt: MARKED_LOST_AT,
  lastSeenLat: null,
  lastSeenLng: null,
  ownerDisplayName: null,
};

describe("Pérdidas · LostPetRow — dominant-anatomy atoms (A5)", () => {
  it("renders the case code through the shared OpCodeBadge atom, still inside its link", () => {
    const html = renderToStaticMarkup(
      <LostPetRow pet={LOST_PET} caseCode="CAS-0001-0001" showOwnerDetail={true} />,
    );
    expect(html).toContain(codeBadgeMarkup("blue", "CAS-0001-0001"));
    // The link survives the atom swap — the code is still the way into the case.
    expect(html).toContain('href="/gob/casos/CAS-0001-0001"');
  });

  it("renders the absolute lost-since date via the shared formatDate, inside a <time>", () => {
    const html = renderToStaticMarkup(
      <LostPetRow pet={LOST_PET} caseCode="CAS-0001-0001" showOwnerDetail={true} />,
    );
    expect(html).toContain(`<time dateTime="${MARKED_LOST_AT.toISOString()}"`);
    expect(html).toContain(formatDate(MARKED_LOST_AT));
  });

  it("keeps the elapsed-time signal, promoted into the shared status-pill primitive", () => {
    // Unifying to an absolute date must not cost this queue its recency signal —
    // the resolution was "absolute date PLUS an elapsed pill where urgency IS
    // the datum", the same pairing CaseQueue uses for its ≥14-day SLA pill.
    const html = renderToStaticMarkup(
      <LostPetRow pet={LOST_PET} caseCode="CAS-0001-0001" showOwnerDetail={true} />,
    );
    expect(html).toContain("hace ");
    // OpPill(neutral) → OpStatusPill geometry. A duration is not a breach, so
    // the pill is deliberately neutral, never an st-err/st-warn claim.
    expect(html).toContain("font-ln-mono");
    expect(html).toContain("Tiempo transcurrido desde la denuncia de pérdida");
  });

  it("the compact (national-view) row gets the same date treatment", () => {
    const html = renderToStaticMarkup(<LostPetRow pet={LOST_PET} showOwnerDetail={false} />);
    expect(html).toContain(`<time dateTime="${MARKED_LOST_AT.toISOString()}"`);
    expect(html).toContain(formatDate(MARKED_LOST_AT));
  });

  it("a pet with no marked-lost timestamp renders one honest dash, never '— —'", () => {
    const html = renderToStaticMarkup(
      <LostPetRow pet={{ ...LOST_PET, markedLostAt: null }} showOwnerDetail={true} />,
    );
    expect(html).not.toContain("<time");
    expect(html).not.toContain("— —");
  });
});

// ---------------------------------------------------------------------------
// Aprobaciones — BulkApprovalQueueList
// ---------------------------------------------------------------------------

const CREATED_AT_ISO = "2026-07-02T09:30:00.000Z";

const APPROVAL_ITEMS = [
  {
    publicToken: "REQ-AAAA-1111",
    type: "organization_verification" as const,
    typeLabel: "Verificación de organizaciones",
    applicantName: "Refugio Sur",
    jurisdiction: "La Plata, Buenos Aires",
    createdAt: CREATED_AT_ISO,
  },
  {
    publicToken: "REQ-BBBB-2222",
    type: "role_upgrade_vet" as const,
    typeLabel: "Matrículas veterinarias",
    applicantName: "Dra. Juana Pérez",
    jurisdiction: "Palermo, CABA",
    createdAt: CREATED_AT_ISO,
  },
];

function renderApprovals(): string {
  return renderToStaticMarkup(
    <BulkApprovalQueueList items={APPROVAL_ITEMS} detailUrlPrefix="/gob/cola" />,
  );
}

/** The queue's row fragments, so a per-row assertion can't pass on a sibling row. */
function approvalRows(html: string): string[] {
  return html.split("<li ").slice(1);
}

describe("Aprobaciones · BulkApprovalQueueList — dominant-anatomy atoms (A5)", () => {
  it("renders each request token through the shared OpCodeBadge atom, not bare mono text", () => {
    const html = renderApprovals();
    expect(html).toContain(codeBadgeMarkup("blue", "REQ-AAAA-1111"));
    expect(html).toContain(codeBadgeMarkup("blue", "REQ-BBBB-2222"));
  });

  it("renders the request date via the shared formatDate, not the queue's private short format", () => {
    const html = renderApprovals();
    expect(html).toContain(`<time dateTime="${CREATED_AT_ISO}"`);
    expect(html).toContain(formatDate(CREATED_AT_ISO));
    // The formatDateShort vocabulary this queue had drifted to ("2 jul 2026").
    expect(html).not.toContain(formatDateShort(CREATED_AT_ISO));
  });

  it("gives every row a state indicator — the queue that had none", () => {
    const rows = approvalRows(renderApprovals());
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatch(/Pendiente|Verificación individual/);
    }
  });

  it("the state pill declares the bulk-approve gate up front instead of on failure", () => {
    // A literal "Pendiente" on every row would have been a constant: this queue
    // fetches status='pending' exclusively. What varies — and what the operator
    // otherwise discovers only by selecting a row and finding "Aprobar" disabled
    // — is that vet matrículas are excluded from bulk approve.
    const rows = approvalRows(renderApprovals());
    const orgRow = rows.find((r) => r.includes("REQ-AAAA-1111")) ?? "";
    const vetRow = rows.find((r) => r.includes("REQ-BBBB-2222")) ?? "";

    expect(orgRow).toContain("Pendiente");
    expect(orgRow).not.toContain("Verificación individual");

    expect(vetRow).toContain("Verificación individual");
    expect(vetRow).not.toContain(">Pendiente<");
  });
});
