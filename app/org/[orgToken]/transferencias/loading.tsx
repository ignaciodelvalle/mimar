/**
 * loading.tsx — skeleton for /org/[orgToken]/transferencias (transfers list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgTransferenciasLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
