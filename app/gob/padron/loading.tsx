/**
 * loading.tsx — skeleton for /gob/padron (Padrón hub — Población + Censo tabs).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobPadronLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6, 5]} />;
}
