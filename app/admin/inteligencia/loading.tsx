/**
 * loading.tsx — skeleton for /admin/inteligencia (intelligence dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminInteligenciaLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6]} />;
}
