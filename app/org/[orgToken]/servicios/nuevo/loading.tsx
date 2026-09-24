/**
 * loading.tsx — skeleton for /org/[orgToken]/servicios/nuevo (new service offering form).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgServicioNuevoLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[3]} />;
}
