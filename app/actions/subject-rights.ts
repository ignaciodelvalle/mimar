"use server";

// subject-rights.ts — thin shim (strangler migration 57/61).
//
// Business logic moved to:
//   src/modules/auth/application/subject-rights/
//
// This file re-exports all originally-exported symbols (2 actions + 2 types)
// with identical signatures so all callers keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function — bare `export { x } from "..."` re-exports are rejected by the
// Next.js compiler. Types are re-exported with `export type` (erased at runtime).

import { eraseMySubjectDataAction as _eraseMySubjectDataAction } from "@/src/modules/auth/application/subject-rights/erase-subject-data";
import { exportMySubjectDataAction as _exportMySubjectDataAction } from "@/src/modules/auth/application/subject-rights/export-subject-data";

export type {
  ExportSubjectDataResult,
  EraseSubjectDataResult,
} from "@/src/modules/auth/application/subject-rights/types";

// @no-auth-required: auth enforced inside the delegated use-case (requireUserOrRedirect() gates the export)
export async function exportMySubjectDataAction(
  ...args: Parameters<typeof _exportMySubjectDataAction>
) {
  return _exportMySubjectDataAction(...args);
}

// @no-auth-required: auth enforced inside the delegated use-case (requireUserOrRedirect() gates the erase)
export async function eraseMySubjectDataAction(
  ...args: Parameters<typeof _eraseMySubjectDataAction>
) {
  return _eraseMySubjectDataAction(...args);
}
