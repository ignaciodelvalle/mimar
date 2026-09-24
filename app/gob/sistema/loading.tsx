/**
 * loading.tsx — skeleton for /gob/sistema (system settings dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobSistemaLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6]} />;
}
