import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RESUBMITTABLE_AFTER_WITHDRAWAL,
  canResubmitAfterWithdrawal,
} from "./approval-resubmission";

// The allowlist is a claim about OTHER files: that withdrawing a request of this
// type lets the applicant send another one. These tests check the claim against
// those files rather than restating it, because the cost of the list being wrong
// is not a failed test — it is a shelter following on-screen advice and losing
// its organisation permanently.
const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const CREATION_GUARDS: Record<string, string> = {
  role_upgrade_vet: "src/modules/organizations/application/upgrade/request-vet-upgrade.ts",
  service_dog_credential_verification:
    "src/modules/pets/application/service-dog/submit-verification-request.ts",
};

describe("re-submission after withdrawal", () => {
  it("only allowlists types whose creation guard keys on a PENDING row", () => {
    // A guard that keys on `status = "pending"` stops blocking the moment the
    // applicant withdraws, which is precisely what makes the advice true.
    expect(RESUBMITTABLE_AFTER_WITHDRAWAL.length).toBeGreaterThan(0);
    for (const type of RESUBMITTABLE_AFTER_WITHDRAWAL) {
      const path = CREATION_GUARDS[type];
      expect(path, `no creation guard mapped for ${type}`).toBeDefined();
      expect(read(path)).toContain('eq(approvalRequests.status, "pending")');
    }
  });

  it("never allowlists organization_verification, whose guard survives withdrawal", () => {
    // create-organization.ts blocks on holding an admin membership, not on a
    // pending request, and withdrawing does not end the membership.
    const source = read("src/modules/organizations/application/upgrade/create-organization.ts");
    expect(source).toContain("alreadyAdmin");
    expect(source).toContain("Ya administrás una organización.");
    expect(canResubmitAfterWithdrawal("organization_verification")).toBe(false);
  });

  it("fails closed for a type nobody has checked", () => {
    // New request types must not inherit advice that can strand their applicant.
    for (const unchecked of [
      "role_upgrade_govt",
      "role_upgrade_admin",
      "govt_assignment_grant",
      "some_future_type",
      "",
    ]) {
      expect(canResubmitAfterWithdrawal(unchecked)).toBe(false);
    }
  });
});
