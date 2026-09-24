"use server";

// dni-verification.ts — thin shim (strangler migration 38/61).
//
// Business logic moved to:
//   src/modules/auth/application/dni-verification/
//
// This file provides verifyDniAction (the outer auth-guarded server action
// consumed by useActionState). The inner writer lives in the application
// module and is deliberately NOT exported from this "use server" file —
// exporting it would make it an independently-addressable server action that
// accepts an attacker-supplied userId for a PII write (authz triage
// 2026-07-04). Tests import it from
// src/modules/auth/application/dni-verification/verify-dni.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import { sanitizeNext } from "@/lib/domain/dni-next";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import type { DniVerifyFormState } from "@/src/modules/auth/application/dni-verification/types";
import { verifyDniForUser as _verifyDniForUser } from "@/src/modules/auth/application/dni-verification/verify-dni";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  DniVerifyFormState,
  DniVerifyResult,
} from "@/src/modules/auth/application/dni-verification/types";

// ---------------------------------------------------------------------------
// Outer server action — gates via auth guard, then delegates to writer.
// ---------------------------------------------------------------------------

export async function verifyDniAction(
  _prev: DniVerifyFormState,
  formData: FormData,
): Promise<DniVerifyFormState> {
  const { user } = await requireUserOrRedirect();

  const rawDni = String(formData.get("dni") ?? "").trim();
  const next = sanitizeNext(String(formData.get("next") ?? ""));

  const result = await _verifyDniForUser(user.id, rawDni);
  if (!result.ok) {
    return { error: result.error };
  }

  revalidatePath("/cuenta");
  return { error: null, ok: true, next };
}
