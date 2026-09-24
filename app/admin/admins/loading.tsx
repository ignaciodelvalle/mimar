/**
 * loading.tsx — skeleton for /admin/admins (admin accounts list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminAdminsLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
