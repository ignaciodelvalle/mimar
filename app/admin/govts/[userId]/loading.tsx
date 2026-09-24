/**
 * loading.tsx — skeleton for /admin/govts/[userId] (govt account detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminGovtDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
