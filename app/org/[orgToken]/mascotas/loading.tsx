/**
 * loading.tsx — skeleton for /org/[orgToken]/mascotas (pets registry list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgMascotasLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
