/**
 * loading.tsx — skeleton for /admin/panorama (panorama analytics dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminPanoramaLoading() {
  return <OpDashboardSkeleton filterBar={false} kpis={4} cards={[6, 4]} />;
}
