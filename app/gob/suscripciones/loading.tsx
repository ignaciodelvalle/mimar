/**
 * loading.tsx — skeleton for /gob/suscripciones (subscription list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobSuscripcionesLoading() {
  return <OpDashboardSkeleton cards={[6, 5]} />;
}
