/**
 * loading.tsx — skeleton for /admin/padron (admin Padrón hub — Población +
 * Censo tabs).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminPadronLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6, 5]} />;
}
