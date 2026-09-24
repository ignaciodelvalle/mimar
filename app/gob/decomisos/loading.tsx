/**
 * loading.tsx — skeleton for /gob/decomisos (seizure/decomiso list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobDecomisosLoading() {
  return <OpDashboardSkeleton cards={[6, 5]} />;
}
