/**
 * loading.tsx — skeleton for /gob/adopciones (adoption program dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobAdopcionesLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[8]} />;
}
