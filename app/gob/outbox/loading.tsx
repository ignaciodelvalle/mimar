/**
 * loading.tsx — skeleton for /gob/outbox (outbox queue).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobOutboxLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
