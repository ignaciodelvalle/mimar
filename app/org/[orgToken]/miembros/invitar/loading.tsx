/**
 * loading.tsx — skeleton for /org/[orgToken]/miembros/invitar (invite member form).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgMiembroInvitarLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[3]} />;
}
