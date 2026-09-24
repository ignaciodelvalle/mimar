/**
 * loading.tsx — skeleton for /admin/outbox (outbox queue).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminOutboxLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
