/**
 * loading.tsx — skeleton for /admin/casos/[publicCode] (case detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminCasoDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
