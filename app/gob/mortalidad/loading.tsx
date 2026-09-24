/**
 * loading.tsx — skeleton for /gob/mortalidad (mortality surveillance dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobMortalidadLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6, 4]} />;
}
