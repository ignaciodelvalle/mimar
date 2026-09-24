// materialize-offering-now.ts — "Materializar ahora" use-case (strangler 28/61).
// Moved VERBATIM from app/actions/slot-materialization.ts — including the
// requireCapability gate at its original position so the order of business
// checks vs. the capability check (and their exact error messages) is preserved.

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db, serviceOfferings } from "@/db";
import { requireCapability } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { materializeSlotsForOffering } from "./materialize-slots";
import type { MaterializeNowResult } from "./types";

/**
 * Server use-case wired to the "Materializar ahora" button on org agenda pages.
 */
export async function materializeOfferingNow(offeringToken: string): Promise<MaterializeNowResult> {
  const [offering] = await db
    .select({
      id: serviceOfferings.id,
      organizationId: serviceOfferings.organizationId,
      status: serviceOfferings.status,
    })
    .from(serviceOfferings)
    .where(eq(serviceOfferings.publicToken, offeringToken))
    .limit(1);

  if (!offering) return { error: "Servicio no encontrado." };
  if (offering.status !== "approved") {
    return { error: "Solo se pueden materializar turnos para servicios aprobados." };
  }
  if (!offering.organizationId) return { error: "Proveedor del servicio no reconocido." };

  const auth = await requireCapability("service_offering.create", offering.organizationId);
  if (auth.error !== null) return { error: auth.error };
  if (auth.organization?.id !== offering.organizationId) {
    return { error: "No tenés permiso para materializar turnos de este servicio." };
  }

  try {
    const result = await materializeSlotsForOffering(offering.id);
    revalidatePath(`/org/${auth.organization.publicToken}/servicios/${offeringToken}/agenda`);
    return result;
  } catch (err) {
    return {
      error: `Error al materializar: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }
}
