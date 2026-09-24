/**
 * loading.tsx — skeleton for /org/[orgToken]/voluntarios (volunteers list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgVoluntariosLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
