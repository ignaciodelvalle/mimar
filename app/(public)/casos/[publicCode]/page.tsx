// Unified case-detail page (citizen shell). Reachable from /casos/CAS-XXXX-XXXX.
//
// The role-aware body — data fetch, session resolution, canReadCase gating and
// rendering — lives in the shared CaseDetailView so the govt operator route
// (app/gob/casos/[publicCode]) can reuse the exact same content inside the
// operator shell. See that component for the full access-control notes.

import { headers } from "next/headers";

import { CaseDetailView } from "@/components/casos/CaseDetailView";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";

// Reads auth cookies (viewer-dependent PII gating) — never statically cache.
// Cache policy: ALWAYS LIVE. force-dynamic + `Cache-Control: no-store` (stamped
// in middleware for the /casos/ subtree — see lib/infra/public-cache-policy.ts)
// so a shared/CDN cache can never cross-serve one viewer's PII-gated variant.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ publicCode: string }>;
}

// Resolve the trusted caller IP from request headers for the per-IP rate limit.
// Falls back to "unknown" if headers() is unavailable (non-request context).
async function callerIpFromHeaders(): Promise<string> {
  try {
    const reqHeaders = await headers();
    return callerIp(reqHeaders);
  } catch {
    return "unknown";
  }
}

// Soft throttle notice shown when a single IP exceeds the per-IP read limit.
// A friendly message (not a hard error) so a legitimate viewer is never locked
// out of a case they can access — mirrors the /p/[publicToken] ThrottleNotice.
function CaseThrottleNotice() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-[400px] px-6 py-12 text-center text-[var(--color-ln-ink)]">
        <p className="mb-3 text-lg font-semibold" style={{ fontFamily: "var(--font-ln-serif)" }}>
          Demasiadas consultas
        </p>
        <p className="text-md leading-[1.6] text-[var(--color-ln-ink-2)]">
          Estás realizando demasiadas consultas desde esta conexión. Esperá unos minutos y volvé a
          intentarlo.
        </p>
      </div>
    </div>
  );
}

export default async function CaseDetailPage({ params }: PageProps) {
  const { publicCode } = await params;

  // Per-IP rate limit BEFORE CaseDetailView runs its multi-join read
  // (getCaseDetailByPublicCode joins pets + events + case_events and resolves
  // opener/closer display names). The query executes before any auth/role
  // resolution, so an anonymous caller can drive DB cost by hammering CAS
  // codes. The public code is high entropy, but the read path is otherwise
  // unbounded — mirror the /p/[publicToken] and denuncia_receipt guards. Soft
  // throttle notice (not a hard error) preserves UX for a legitimate viewer.
  // Only the public route is guarded; the /gob operator route is unaffected.
  const ip = await callerIpFromHeaders();
  try {
    await enforceRateLimit("case_detail_public", ip, { maxPerMinute: 30, maxPerHour: 200 });
  } catch (err) {
    if (err instanceof RateLimitError) return <CaseThrottleNotice />;
    throw err;
  }

  return <CaseDetailView publicCode={publicCode} />;
}
