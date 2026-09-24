/**
 * loading.tsx — skeleton for /gob/reglas/[country]/[province]/[locality] (jurisdiction rules list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobReglasJurisdiccionLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
