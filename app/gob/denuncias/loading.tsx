/**
 * loading.tsx — skeleton for /gob/denuncias (the Denuncias hub, C6a).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobDenunciasLoading() {
  return <OpDashboardSkeleton filterBar={false} kpis={3} cards={[3, 3, 3]} maxWidth="max-w-6xl" />;
}
