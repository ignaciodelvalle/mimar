"use server";

// quick-capture.ts — thin shim (strangler migration 56/61, 2026-06-30).
//
// Business logic moved to:
//   src/modules/events/application/quick-capture/
//
// This file re-exports all originally-exported symbols (1 action + 1 type)
// with identical signatures so all callers keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { quickCapture } from "@/src/modules/events/application/quick-capture/quick-capture";
import type { QuickCaptureResult } from "@/src/modules/events/application/quick-capture/types";

export type { QuickCaptureResult };

// @no-auth-required: no auth needed — public token identifies the pet; no account required
export async function quickCaptureAction(
  publicToken: string,
  text: string,
): Promise<QuickCaptureResult> {
  return quickCapture(publicToken, text);
}
