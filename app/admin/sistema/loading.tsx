/**
 * loading.tsx — skeleton for /admin/sistema (system settings dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminSistemaLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6, 4]} />;
}
