/**
 * loading.tsx — skeleton for /gob/historial (audit trail / event ledger).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobHistorialLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
