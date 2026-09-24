/**
 * loading.tsx — skeleton for /org/[orgToken]/agenda/turnos/[appointmentToken] (appointment detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgTurnoDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[4]} />;
}
