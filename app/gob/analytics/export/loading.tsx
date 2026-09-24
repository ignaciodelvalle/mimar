/**
 * loading.tsx — skeleton for /gob/analytics/export (analytics export form).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobAnalyticsExportLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[3]} />;
}
