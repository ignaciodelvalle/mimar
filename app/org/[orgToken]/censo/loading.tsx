/**
 * loading.tsx — skeleton for /org/[orgToken]/censo (census dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgCensoLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
