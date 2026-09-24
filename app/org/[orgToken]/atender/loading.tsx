/**
 * loading.tsx — skeleton for /org/[orgToken]/atender (attend-pet queue).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgAtenderLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
