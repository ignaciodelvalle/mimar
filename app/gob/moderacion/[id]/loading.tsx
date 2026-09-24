/**
 * loading.tsx — skeleton for /gob/moderacion/[id] (moderation case detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobModeracionDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
