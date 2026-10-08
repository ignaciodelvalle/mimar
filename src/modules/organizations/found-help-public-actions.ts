"use server";

// The anonymous finder's plan-B lookup on /encontre-un-animal (P4; design note
// docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md). A catalogue
// locality id in, the public-safe projection out. Per-IP limit first. A POST,
// so nothing about the place rides in a URL or an access log.
//
// Its own file, imported ONLY by the public page: see the note in
// found-animal-actions.ts on why the authenticated settings card must not
// import the public limiter.

import { summarizeDeadLetterError } from "@/lib/infra/dead-letter-error-summary";
import { isFoundHelpLookupThrottled } from "@/lib/infra/found-help-limits";
import { reportError } from "@/lib/infra/report-error";
import {
  type LookupNearbyHelpResult,
  lookupNearbyHelpForLocality,
} from "@/src/modules/organizations/application/find-nearby-help";

export type { LookupNearbyHelpResult };

// @no-auth-required: the anonymous finder of an animal is the whole audience.
// Input is a public catalogue locality id (never a coordinate); output is the
// public-safe projection of organizations that chose to be listed. Per-IP
// limited (lib/infra/found-help-limits.ts) BEFORE any read. Nothing is stored
// and nothing about the place is logged.
export async function findNearbyHelpAction(input: {
  localityId: string;
  includeVets: boolean;
}): Promise<LookupNearbyHelpResult> {
  try {
    return await lookupNearbyHelpForLocality(
      { localityId: String(input?.localityId ?? ""), includeVets: input?.includeVets === true },
      { isThrottled: isFoundHelpLookupThrottled },
    );
  } catch (err) {
    // Reported WITHOUT the input: the locality the finder picked is theirs, and
    // a DrizzleQueryError's message carries the query's params.
    reportError("found-help/lookup", new Error(summarizeDeadLetterError(err)));
    return { ok: false, error: "unavailable" };
  }
}
