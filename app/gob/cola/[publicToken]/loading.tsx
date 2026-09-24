/**
 * loading.tsx — skeleton for /gob/cola/[publicToken] (queue item detail).
 */

import { DegradedFallback } from "@/components/ui/DegradedFallback";
import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobColaDetailLoading() {
  // degraded-states: escalates to waiting text / degraded card if this
  // boundary stalls (pure CSS — see components/ui/DegradedFallback.tsx).
  return (
    <DegradedFallback>
      <OpDashboardSkeleton filterBar={false} cards={[6]} />
    </DegradedFallback>
  );
}
