/**
 * loading.tsx — skeleton for /org/[orgToken]/transferencias/recibidas (received transfers list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgTransferenciasRecibidasLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
