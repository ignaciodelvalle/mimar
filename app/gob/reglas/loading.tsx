/**
 * loading.tsx — skeleton for /gob/reglas (business rules console).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobReglasLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
