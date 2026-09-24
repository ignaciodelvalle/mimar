/**
 * loading.tsx — skeleton for /gob/panorama (panorama analytics dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobPanoramaLoading() {
  return <OpDashboardSkeleton filterBar={false} kpis={4} cards={[6, 4]} />;
}
