// Authz regression guard — bare inner writers must NOT be exported from
// "use server" files (authz triage verdict 2026-07-04).
//
// Every export of a "use server" module is an independently-addressable
// server action. A bare `*ForUser` / `*ForAuthority` / reader export that
// accepts a caller-supplied userId (or no guard at all) lets any client act
// as any user whose UUID is known — and RLS does NOT back this up, because
// db/index.ts connects with postgres-js (no Supabase JWT), so app-layer
// guards are the only defense.
//
// These are source-level assertions (no DB needed): they fail if someone
// re-exports one of the triaged writers from its "use server" shim. The
// writers themselves still exist in plain application modules, where they are
// not client-addressable.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  IMPERSONATION_SUFFIXES,
  findImpersonationExports,
  listActionFiles,
} from "../scripts/check-authz-guards";

const ROOT = resolve(__dirname, "..");

function source(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

function exportRegex(name: string): RegExp {
  // Matches `export async function <name>(`, `export function <name>(` and
  // re-export forms `export { <name> }` / `export { x as <name> }`.
  return new RegExp(
    `export\\s+(async\\s+)?function\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
  );
}

// ---------------------------------------------------------------------------
// PATTERN GUARD (authz triage 2026-07-04) — not an allowlist.
//
// Sweeps the ENTIRE server-action surface (app/actions/*.ts +
// src/modules/**/actions.ts, via the same listActionFiles the lint:authz
// script uses) and fails if ANY "use server" module exports a function whose
// name ends in ForUser / ForAuthority / ForOrg — declared exports and
// runtime re-export lists alike. A new bare writer export anywhere in the
// surface fails this test without anyone editing FORBIDDEN_EXPORTS below.
// ---------------------------------------------------------------------------

describe(`pattern guard — no "use server" module exports *${IMPERSONATION_SUFFIXES.join(" / *")}`, () => {
  const files = listActionFiles();

  it("scans a non-empty server-action surface", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const relPath = file.replaceAll("\\", "/");
    it(`${relPath} has no impersonation-class export`, () => {
      expect(findImpersonationExports(relPath, source(relPath))).toEqual([]);
    });
  }

  // Negative cases — prove the detector actually fires (a broken regex would
  // otherwise make the whole sweep vacuously green).
  it("flags a declared impersonation export", () => {
    const src = '"use server";\nexport async function updateProfileForUser(id: string) {}\n';
    expect(findImpersonationExports("x.ts", src)).toHaveLength(1);
  });

  it("flags a runtime re-export (including `as` renames)", () => {
    const src = '"use server";\nexport { inner as approveRequestForAuthority };\n';
    expect(findImpersonationExports("x.ts", src)).toHaveLength(1);
  });

  it("ignores type-only re-exports and non-'use server' modules", () => {
    const typeOnly = '"use server";\nexport type { CreateShareForUser } from "./types";\n';
    expect(findImpersonationExports("x.ts", typeOnly)).toEqual([]);
    const plainModule = "export async function updateProfileForUser(id: string) {}\n";
    expect(findImpersonationExports("x.ts", plainModule)).toEqual([]);
  });
});

// file → writer names that must NOT be exported from that "use server" file.
// (Legacy explicit list — still valuable for suffixes the pattern guard does
// not cover: Writer, ForOwner, ForOffering, ForEvents, loadProposalContext.)
const FORBIDDEN_EXPORTS: Record<string, string[]> = {
  "app/actions/approval-requests.ts": ["withdrawApprovalRequestForUser"],
  "app/actions/microchip.ts": ["replaceMicrochipForUser"],
  "app/actions/dni-verification.ts": ["verifyDniForUser"],
  "app/actions/decomiso.ts": ["resolveGovtOrgForUser"],
  "app/actions/alert-firings.ts": ["recordFiringsForUser"],
  // Review 07 (2026-07-05) — caller-supplied actorUserId on a client-callable
  // export (PII-audit forgery). Server-component pages import it from the module.
  "app/actions/admin-proposals.ts": ["logPiiReadSafely"],
  // Review 07 (2026-07-05) — *Writer exports removed (impersonation / no-auth
  // client-callable surface). Writers now import from src/modules/** in tests.
  "app/actions/business-rules.ts": [
    "createBusinessRuleWriter",
    "updateBusinessRuleWriter",
    "deleteBusinessRuleWriter",
  ],
  "app/actions/pregnancy.ts": ["recordPregnancyStartedWriter", "recordPregnancyEndedWriter"],
  "app/actions/chip-match.ts": [
    "confirmChipMatchAsRefugioWriter",
    "confirmChipMatchAsVecinoWriter",
  ],
  "app/actions/booking.ts": ["bookSlotWriter"],
  "app/actions/attendance.ts": ["markAppointmentAttendedWriter"],
  "app/actions/service-offerings.ts": ["updateOfferingCapacityWriter"],
  "app/actions/slot-materialization.ts": [
    "materializeSlotsForOffering",
    "materializeAllActiveSlots",
  ],
  "app/actions/custody-disputes.ts": ["openDisputeFromEvent"],
  "app/actions/amendment.ts": ["fetchLatestAmendmentsForEvents"],
  "app/actions/return-to-owner.ts": [
    "fetchPendingReturnProposalForOwner",
    "fetchPendingOwnerReturnProposalForOrg",
    "loadProposalContext",
    "proposeReturnAsRefugioWriter",
    "proposeReturnAsVecinoWriter",
    "ownerAcceptReturnWriter",
    "ownerRejectReturnWriter",
    "actorCancelProposalWriter",
    "ownerProposeReturnToOrgWriter",
    "orgAcceptOwnerReturnWriter",
    "orgRejectOwnerReturnWriter",
  ],
  "src/modules/organizations/actions.ts": ["updateOrganizationForUser"],
};

describe("bare writers are not exported from 'use server' modules", () => {
  for (const [file, names] of Object.entries(FORBIDDEN_EXPORTS)) {
    for (const name of names) {
      it(`${file} does not export ${name}`, () => {
        const src = source(file);
        // Sanity: these files must still be server-action modules.
        expect(src.startsWith('"use server"')).toBe(true);
        expect(src).not.toMatch(exportRegex(name));
      });
    }
  }
});

describe("uploadRevocationEvidence derives the actor from the session", () => {
  const file = "app/actions/revocation-evidence.ts";

  it("no longer accepts a caller-supplied actorUserId", () => {
    const src = source(file);
    // The exported action's parameter list must not carry an actor id.
    expect(src).not.toMatch(
      /export\s+async\s+function\s+uploadRevocationEvidence\s*\([^)]*actorUserId/s,
    );
    // The action must bind the session inside the "use server" file via the
    // institutional admin/govt guard (commits c819a2f9 + a45c68a6) — stronger
    // than a bare auth.getUser() since it also rejects deactivated/erased actors.
    expect(src).toContain("requireAdminOrGovtOrRedirect");
  });
});
