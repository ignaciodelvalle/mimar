// bulk-vaccinate-types.ts — thin re-export shim (strangler migration 54/61).
//
// Shared bulk types/utils moved to:
//   src/modules/events/application/bulk/bulk-vaccinate-types.ts
//
// This file is NOT a "use server" file, so both runtime values and types are
// re-exported directly (no async-wrapper constraint). Importers are unchanged.

export {
  BULK_INELIGIBLE_REASONS,
  isValidBulkActionId,
} from "@/src/modules/events/application/bulk/bulk-vaccinate-types";
export type {
  BulkIneligibleReason,
  BulkPublishListingInput,
  BulkSetEligibilityInput,
  BulkVaccinateInput,
} from "@/src/modules/events/application/bulk/bulk-vaccinate-types";
