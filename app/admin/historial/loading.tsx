/**
 * loading.tsx — skeleton for /admin/historial (audit trail / event ledger).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminHistorialLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
