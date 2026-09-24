/**
 * loading.tsx — skeleton for /org/[orgToken]/mascotas/[publicToken]/adoption (adoption detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgMascotaAdoptionLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[4]} />;
}
