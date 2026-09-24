/**
 * loading.tsx — skeleton for /gob/vigilancia/investigaciones (epidemiological investigations queue).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobInvestigacionesLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
