/**
 * loading.tsx — skeleton for /gob/moderacion (moderation queue).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobModeracionLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
