/**
 * loading.tsx — skeleton for /org/[orgToken]/transitos (fosters list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgTransitosLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
