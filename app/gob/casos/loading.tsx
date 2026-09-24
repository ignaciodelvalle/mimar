/**
 * loading.tsx — skeleton for /gob/casos (case/expediente queue).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobCasosLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
