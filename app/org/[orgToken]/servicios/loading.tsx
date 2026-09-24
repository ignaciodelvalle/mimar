/**
 * loading.tsx — skeleton for /org/[orgToken]/servicios (services offerings list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgServiciosLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
