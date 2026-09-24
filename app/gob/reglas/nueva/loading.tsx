/**
 * loading.tsx — skeleton for /gob/reglas/nueva (the "Crear regla" wizard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobReglasNuevaWizardLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[3]} />;
}
