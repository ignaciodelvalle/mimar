/**
 * loading.tsx — skeleton for /org/[orgToken]/maltrato/recibidos (received welfare reports list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgMaltratoRecibidosLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
