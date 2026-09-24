/**
 * loading.tsx — skeleton for /org/[orgToken]/intake (intake queue).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgIntakeLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
