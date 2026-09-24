/**
 * loading.tsx — skeleton for /org/[orgToken]/pets/no-aptas (ineligible pets list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgPetsNoAptasLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
