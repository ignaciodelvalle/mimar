// The `POST /api/v1/pets/{publicToken}/travel/export` body (viajes-fase-2,
// task 6.5): the travel PDF for the native app.
//
// ONE CORE, TWO DOORS. `exportTravelPdfForViewer` is what the web's "Descargar
// documentación de viaje" button reaches through its Server Action; this is the
// bearer door to the same function. It reads the trip through loadTravelView —
// the reading `GET .../travel` sends the native screen — so the PDF the phone
// shares carries the semáforo the phone shows.
//
// WHO: the travel titular (`canAccessTravel` — owner, co-owner, foster on the
// person path). Everyone else — a stranger, a caretaker, the org path — gets
// `not_found`, the web export's answer and the one a pet that does not exist
// gets. The PDF names the destination and the date; unlike the GET, whose
// `travel_forbidden` lets the native screen explain itself, this door has
// nothing to explain to a caller who could never have reached its button.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import {
  type PetHolderAccess,
  canAccessTravel,
  resolvePetHolderAccess,
} from "@/lib/infra/pet-access";
import { exportTravelPdfForViewer } from "@/src/modules/pets/application/travel-export/generate-travel-export";
import type { PetTravelExportV1 } from "@dim/contract/api";

import { unavailable } from "../commands";

/** The access query: indexed, single-row. */
const ACCESS_BUDGET_MS = 5_000;

/**
 * The export: one indexed read of the pet's libreta events, a pdf-lib render
 * of one or two pages, one Storage upload, one signature and one audit insert.
 * Longer than a read on purpose — the upload is a network hop to Storage.
 */
const EXPORT_BUDGET_MS = 20_000;

export type TravelExportContext = {
  publicToken: string;
  userId: string;
  /** `?trip=` — the trip to print; the next one when absent or unknown. */
  tripId: string | null;
  now?: Date;
};

/** Everything from the access guard to the ack. */
export async function exportPetTravel(ctx: TravelExportContext) {
  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(ctx.publicToken, ctx.userId),
      ACCESS_BUDGET_MS,
      "api-v1-travel-export-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not read, a pet they hold without being its travel
  // titular, and a pet that does not exist answer IDENTICALLY.
  if (access.kind !== "owner" || !canAccessTravel("owner", access.holderRole)) {
    return apiV1Error("not_found", 404);
  }

  let result: Awaited<ReturnType<typeof exportTravelPdfForViewer>>;
  try {
    result = await withDbBudgetOrThrow(
      exportTravelPdfForViewer({
        userId: ctx.userId,
        pet: access.pet,
        viewer: { accessPath: "owner", holderRole: access.holderRole },
        tripId: ctx.tripId,
        now: ctx.now,
      }),
      EXPORT_BUDGET_MS,
      "api-v1-travel-export",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  if (!result.ok) {
    switch (result.error) {
      case "not_found":
        return apiV1Error("not_found", 404);
      case "no_movement_context":
        return apiV1Error("trip_not_found", 404);
      case "pdf_render_failed":
      case "storage_upload_failed":
      case "signed_url_failed":
        return apiV1Error("travel_failed", 500);
      default: {
        const unhandled: never = result.error;
        throw new Error(`Unhandled export refusal: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  const ack: PetTravelExportV1 = {
    pdfUrl: result.signedUrl,
    expiresAt: result.expiresAt.toISOString(),
  };
  return apiV1Json(ack, { status: 200 });
}
