/**
 * loading.tsx — skeleton for /org/[orgToken]/casos (cases list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgCasosLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
