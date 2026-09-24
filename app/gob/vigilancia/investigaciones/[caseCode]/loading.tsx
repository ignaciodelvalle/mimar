/**
 * loading.tsx — skeleton for /gob/vigilancia/investigaciones/[caseCode] (investigation case detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobInvestigacionDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
