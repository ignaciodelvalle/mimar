/**
 * loading.tsx — skeleton for /org/[orgToken]/servicios/[offeringToken]/agenda (service offering agenda).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgServicioAgendaLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[4]} />;
}
