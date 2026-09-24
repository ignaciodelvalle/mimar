/**
 * loading.tsx — skeleton for /gob/vigilancia/brotes (outbreak list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobBrotesLoading() {
  return <OpDashboardSkeleton cards={[6]} />;
}
