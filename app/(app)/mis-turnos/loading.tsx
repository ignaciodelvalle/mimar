/**
 * loading.tsx — skeleton for /mis-turnos (citizen's own appointment list).
 */

import { LnPageSkeleton } from "@/components/ui/LnPageSkeleton";

export default function MisTurnosLoading() {
  return <LnPageSkeleton rows={4} avatar={false} cta />;
}
