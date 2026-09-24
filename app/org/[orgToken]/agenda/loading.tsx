/**
 * loading.tsx — skeleton for /org/[orgToken]/agenda (appointments agenda).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgAgendaLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
