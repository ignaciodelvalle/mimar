// Ley 25.326 art. 14 — derecho de acceso. The subject asks for everything we
// hold about them and we hand it over.
//
// THE SPLIT (WU-R, 2026-08-29), AND WHY IT IS A SPLIT AND NOT A SECOND COPY
// ---------------------------------------------------------------------------
// There are now two doors onto this right: the web page's server action, which
// resolves the subject from a COOKIE, and `GET /api/v1/me/privacy`, which
// resolves them from a BEARER token. What must not double is the thing between
// the door and the database — one call to one SECURITY DEFINER RPC that
// authorizes on `auth.uid()`.
//
// So `exportSubjectDataFor` takes an ALREADY-RESOLVED subject and an already-
// authenticated client, and the two doors are the only things that differ. A
// native flow that re-derived "who is asking" would be a second answer to a
// question the RPC also answers, and the two would drift.
//
// AND THE LIMITER IS INSIDE, WHICH IS THE POINT OF THE SPLIT AND NOT A BONUS
// ---------------------------------------------------------------------------
// `revoke-sessions.ts` recorded this lesson on 2026-08-25 in almost these words:
// its per-user ceiling used to live in the route, the web action calling the
// same use-case had none, "so the ceiling was a property of the TRANSPORT, and a
// caller holding a stolen cookie simply used the button instead of the
// endpoint." This surface had the same shape and worse stakes — it had NO
// limiter on either side, and what it returns is the subject's entire PII
// record, which is exactly the payload a stolen credential wants to pull in a
// loop. The budget therefore lands here, where both doors spend it.

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { type RateLimitConfig, RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClient } from "@/lib/supabase/server";

import type { ExportSubjectDataResult } from "./types";

/**
 * ONE bucket for both transports, keyed on the subject.
 *
 * Not `api_v1_…`: a name that says `api_v1` on a call from a web form reads like
 * a different budget, and the whole point is that it is not one.
 */
export const SUBJECT_DATA_EXPORT_USER_BUCKET = "subject_data_export_user";

/**
 * Tight, and tighter than any other authenticated read on this project.
 *
 * The act is "give me a copy of my file". A person does it once, reads the JSON,
 * and possibly does it again after changing something. Three in a minute already
 * describes a double-tap plus a retry; twenty in a day describes nobody.
 *
 * What the ceiling actually bounds is the case that matters: a stolen access
 * token pulling the subject's whole PII record on a loop. Every other read on
 * this surface discloses one screen; this one discloses the file, so it is the
 * one read whose budget is sized against exfiltration rather than against a
 * person tapping.
 *
 * A DAILY FIGURE, unlike the read family's. `API_V1_INBOX_STATE_USER_LIMIT`
 * explains when a daily cap is pointless — "nothing here leaves the caller's own
 * rows" — and this is the inverse case: the bytes leave, permanently, and a
 * hundred slow pulls spread across a day are exactly as bad as a hundred fast
 * ones. An hourly-only bound would let that through by construction.
 */
export const SUBJECT_DATA_EXPORT_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 3,
  maxPerHour: 10,
  maxPerDay: 20,
};

/**
 * es-AR copy for the two refusals, so the web page and the native screen say the
 * same sentence rather than each inventing one.
 */
const RATE_LIMITED_COPY =
  "Pediste tus datos varias veces seguidas. Esperá unos minutos y volvé a intentar.";

export type ExportSubjectDataInput = {
  /** The subject, resolved by the surface's own guard. Never read from a token. */
  userId: string;
  /**
   * A client already authenticated AS the subject — cookie or bearer. The RPC is
   * SECURITY DEFINER and authorizes on `auth.uid()`, so this client IS the
   * authorization and a service-role one would silently bypass it.
   */
  supabase: SupabaseClient;
};

/**
 * Run the export for an already-resolved subject.
 *
 * FAILS CLOSED on the limiter, which is the opposite direction from every
 * limiter on the `/api/v1` transport, and the difference is deliberate. Those
 * bound abuse of a surface and must not be the thing that empties a user's app
 * shell, so they let the request through when the counter cannot be written.
 * This one bounds EXFILTRATION of a PII dump: letting it through on a limiter
 * outage would turn a `rate_limit_buckets` hiccup into an unbounded export. The
 * cost of the strict direction is that a subject exercising art. 14 during that
 * outage is told to try again — a delay, against a leak.
 */
export async function exportSubjectDataFor(
  input: ExportSubjectDataInput,
): Promise<ExportSubjectDataResult> {
  try {
    await enforceRateLimit(
      SUBJECT_DATA_EXPORT_USER_BUCKET,
      input.userId,
      SUBJECT_DATA_EXPORT_USER_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return { ok: false, reason: "rate_limited", error: RATE_LIMITED_COPY };
    }
    reportError("subject-rights/export-limiter", err);
    return { ok: false, reason: "rate_limited", error: RATE_LIMITED_COPY };
  }

  const { data, error } = await input.supabase.rpc("export_subject_data", {
    p_user_id: input.userId,
  });

  if (error) {
    return { ok: false, reason: "failed", error: error.message };
  }
  if (!data) {
    return { ok: false, reason: "failed", error: "El export devolvió vacío." };
  }
  return { ok: true, data: data as Record<string, unknown> };
}

export async function exportMySubjectDataAction(): Promise<ExportSubjectDataResult> {
  const { user } = await requireUserOrRedirect();
  const supabase = await createClient();

  return exportSubjectDataFor({ userId: user.id, supabase });
}
