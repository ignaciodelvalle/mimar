/**
 * loading.tsx — skeleton for /gob/maltrato/[id] (welfare report detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobMaltratoDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6, 4]} />;
}
