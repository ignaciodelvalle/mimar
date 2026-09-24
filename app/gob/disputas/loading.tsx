/**
 * loading.tsx — skeleton for /gob/disputas (disputes queue).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobDisputasLoading() {
  return <OpDashboardSkeleton cards={[6]} />;
}
