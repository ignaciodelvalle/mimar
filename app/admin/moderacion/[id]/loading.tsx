/**
 * loading.tsx — skeleton for /admin/moderacion/[id] (moderation case detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminModeracionDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
