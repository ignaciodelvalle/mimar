/**
 * loading.tsx — skeleton for /gob/reglas/[country]/[province]/[locality]/editar/[ruleId] (edit business rule form).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobReglaEditarLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[4]} />;
}
