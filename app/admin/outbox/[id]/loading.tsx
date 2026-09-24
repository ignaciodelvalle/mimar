/**
 * loading.tsx — skeleton for /admin/outbox/[id] (outbox item detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminOutboxDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
