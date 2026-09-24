/**
 * loading.tsx — skeleton for /org/[orgToken]/checkins (check-ins list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgCheckinsLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
