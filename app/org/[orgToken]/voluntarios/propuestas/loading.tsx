/**
 * loading.tsx — skeleton for /org/[orgToken]/voluntarios/propuestas (volunteer proposals list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgVoluntarioPropuestasLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
