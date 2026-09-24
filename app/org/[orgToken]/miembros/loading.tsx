/**
 * loading.tsx — skeleton for /org/[orgToken]/miembros (members list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgMiembrosLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
