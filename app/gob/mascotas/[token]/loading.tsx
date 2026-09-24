/**
 * loading.tsx — skeleton for /gob/mascotas/[token] (pet sub-view detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobMascotaDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[4]} />;
}
