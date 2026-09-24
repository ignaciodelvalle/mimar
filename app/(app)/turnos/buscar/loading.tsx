/**
 * loading.tsx — skeleton for /turnos/buscar (search available appointment
 * offerings). Search filters render immediately; this covers the results list.
 */

import { LnPageSkeleton } from "@/components/ui/LnPageSkeleton";

export default function BuscarTurnosLoading() {
  return <LnPageSkeleton rows={4} avatar={false} />;
}
