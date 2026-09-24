/**
 * loading.tsx — skeleton for /org/[orgToken]/adopciones (adoption events list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgAdopcionesLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
