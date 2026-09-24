/**
 * loading.tsx — skeleton for /gob/outreach (outreach dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobOutreachLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6, 4]} />;
}
