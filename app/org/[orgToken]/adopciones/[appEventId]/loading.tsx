/**
 * loading.tsx — skeleton for /org/[orgToken]/adopciones/[appEventId] (adoption event detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgAdopcionDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
