/**
 * loading.tsx — skeleton for /admin/moderacion (moderation queue).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminModeracionLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
