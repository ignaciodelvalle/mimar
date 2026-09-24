// Admin operator case-detail. Renders the SAME role-aware case-detail content
// as the public /casos/[publicCode] route, but under the /admin layout so a
// national operator opening a case from /admin/casos KEEPS the operator rail
// and topbar instead of being dropped into the citizen chrome.
//
// This is the admin half of the shell-loss class fixed for govt in task #47.
// Only the govt half was done then: /gob got its in-shell detail route while
// admin kept linking at the public /casos/[publicCode], so the national
// operator still lost the shell (QA ronda 5, 2026-07-16 — the tester opened a
// denuncia from /admin/casos, landed on the citizen chrome with "Adoptar ·
// Refugios · ← Volver a mi app", and could not act on the case).
//
// Access is NOT widened by this route: `app/admin/layout.tsx` already gates the
// whole segment with the STRICT `requireAdminOrRedirect` (govt and everyone else
// land on /), and CaseDetailView re-runs canReadCase independently (admin =
// universal scope).
//
// The guard below therefore never fires in practice — it mirrors the sibling
// `app/admin/casos/page.tsx:37-38` as defence in depth, so the page keeps its
// own gate if the layout is ever relaxed. Its govt branch forwards to the same
// case in the /gob shell rather than dumping the operator on a list. Do not read
// it as the reason govt cannot get here: the layout is.

import { redirect } from "next/navigation";

import { CaseDetailView } from "@/components/casos/CaseDetailView";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";

// Reads auth cookies (viewer-dependent PII gating) — never statically cache.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ publicCode: string }>;
}

export default async function AdminCaseDetailPage({ params }: PageProps) {
  const { publicCode } = await params;
  const session = await requireAdminOrGovtOrRedirect();
  if (session.profile.role !== "admin") redirect(`/gob/casos/${publicCode}`);
  return <CaseDetailView publicCode={publicCode} casosHref="/admin/casos" />;
}
