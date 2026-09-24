// Which approval requests a person can re-send after withdrawing their own.
//
// This exists because "Pedir más información" leaves a request PENDING and the
// applicant has no field to answer in, so every screen that mentions the ask is
// tempted to tell them "retirá y enviá una nueva". For most types that is true.
// For `organization_verification` it is FALSE and following it is irreversible:
// create-organization.ts inserts the organizations row, the admin membership and
// the approval request in ONE transaction, so the org exists before anyone
// approves anything. Withdrawing touches only approval_requests — the org and
// the membership survive — and the next attempt hits `alreadyAdmin` →
// "Ya administrás una organización.". The only route that re-opens verification
// is proposeOrgVerificationForOrg, which needs an admin or govt actor. A shelter
// that follows the advice is unverifiable with no self-serve recovery.
//
// ALLOWLIST, not deny-list, on purpose. A type nobody has checked must not
// inherit advice that can strand its applicant; the honest fallback is to say we
// cannot restart it from here. Add a type only after reading its creation guard
// and confirming the guard keys on `status = "pending"` — which is exactly what
// approval-resubmission.test.ts asserts against the source, so this list cannot
// quietly outgrow its evidence.

export const RESUBMITTABLE_AFTER_WITHDRAWAL = [
  // request-vet-upgrade.ts guards on (applicant, type, status='pending').
  "role_upgrade_vet",
  // submit-verification-request.ts guards on (pet, status='pending').
  "service_dog_credential_verification",
] as const;

export type ResubmittableRequestType = (typeof RESUBMITTABLE_AFTER_WITHDRAWAL)[number];

export function canResubmitAfterWithdrawal(requestType: string): boolean {
  return (RESUBMITTABLE_AFTER_WITHDRAWAL as readonly string[]).includes(requestType);
}
