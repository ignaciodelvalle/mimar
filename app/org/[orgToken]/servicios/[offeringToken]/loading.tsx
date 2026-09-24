/**
 * loading.tsx — skeleton for /org/[orgToken]/servicios/[offeringToken] (service offering detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgServicioDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[4]} />;
}
