/**
 * loading.tsx — skeleton for /org/[orgToken]/atender/[publicToken] (attend-pet detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgAtenderDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[4]} />;
}
