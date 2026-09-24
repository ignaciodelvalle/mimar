/**
 * loading.tsx — skeleton for /org/[orgToken]/mascotas/[publicToken]/adoptar (adoption action form).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgMascotaAdoptarLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[3]} />;
}
