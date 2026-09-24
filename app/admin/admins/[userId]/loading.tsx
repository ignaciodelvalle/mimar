/**
 * loading.tsx — skeleton for /admin/admins/[userId] (admin account detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminAdminDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
