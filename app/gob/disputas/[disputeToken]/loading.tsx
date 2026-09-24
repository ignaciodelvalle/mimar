/**
 * loading.tsx — skeleton for /gob/disputas/[disputeToken] (dispute detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobDisputaDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
