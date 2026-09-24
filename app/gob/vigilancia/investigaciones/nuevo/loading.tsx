/**
 * loading.tsx — skeleton for /gob/vigilancia/investigaciones/nuevo (new investigation form).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobInvestigacionNuevaLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[3]} />;
}
