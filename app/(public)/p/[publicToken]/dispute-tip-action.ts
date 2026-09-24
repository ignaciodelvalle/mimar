"use server";

// Thin action wrapper for the dispute-safe finder tip (colocated with the
// public credential route, mirroring encontre/action.ts). Business logic
// lives in src/modules/custody-disputes/application/report-dispute-tip.ts.
//
// The tip lands on the open custody-dispute CASE (case_events, entry_type
// "finder_tip") for the reviewing authority ONLY — it never notifies and is
// never shown to either disputing party. See the use-case header for the
// dispute-safety invariants.

import { callerIp } from "@/lib/infra/rate-limit";
import { reportDisputeTip } from "@/src/modules/custody-disputes/application/report-dispute-tip";
import type { PublicActionState } from "@/src/modules/pets/application/public/types";
import { headers } from "next/headers";

// @no-auth-required: anonymous finder tip from the public credential of a
// custody-disputed pet. Rate-limited by (IP + publicToken) inside the
// use-case (persistent DB-backed limiter, 1/min, 10/hour per key). Request
// context stays here in the actions layer (ADR 2026-07-18): the trusted
// caller IP is resolved from headers and passed down as a plain argument.
export async function reportDisputeTipAction(
  publicToken: string,
  _previous: PublicActionState,
  formData: FormData,
): Promise<PublicActionState> {
  const reqHeaders = await headers();
  return reportDisputeTip(publicToken, callerIp(reqHeaders), formData);
}
