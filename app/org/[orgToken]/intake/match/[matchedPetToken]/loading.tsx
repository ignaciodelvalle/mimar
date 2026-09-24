/**
 * loading.tsx — skeleton for /org/[orgToken]/intake/match/[matchedPetToken] (intake match detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgIntakeMatchLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[4]} />;
}
