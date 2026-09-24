/**
 * loading.tsx — skeleton for /admin/mascotas/[token] (pet sub-view detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminMascotaDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[4]} />;
}
