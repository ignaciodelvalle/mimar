import { sql } from "drizzle-orm";

import type { EventType } from "@/db/schema";
import { upcastPayload } from "@/lib/events/event-upcasters";
import { findDisease } from "@/lib/reference/diseases";
import { AR_TIME_ZONE, formatWeightKg, parseDateInput } from "@/lib/utils/format";
import { welfareReportKindLabel } from "@/src/modules/welfare/domain/types";

/**
 * Drizzle WHERE clause that excludes the noise floor of "I scanned my own
 * pet's QR" events. Used by every owner-facing timeline query — owners
 * shouldn't see their own self-scans by default, since they generate one
 * per page load and would drown out the real history.
 *
 * `payload->>'is_self_scan' = 'true'` checks the JSONB key as text. Events
 * older than the credential_scanned payload schema (which has always
 * carried is_self_scan since v1) don't exist, so no back-compat fallback.
 *
 * Use as: `where(and(eq(petEvents.petId, pet.id), excludeSelfScansClause()))`.
 */
export function excludeSelfScansClause() {
  return sql`NOT (event_type = 'credential_scanned' AND payload->>'is_self_scan' = 'true')`;
}

/**
 * Authority-only surveillance signals — never rendered on owner/org pet
 * surfaces (umbrella §6 privacy contract). These are govt intel about the
 * pet's surroundings, not facts about the pet's own health record:
 * clickthrough audit 2026-07-03 caught an `outbreak_signal` row rendered in
 * an owner's libreta timeline. `symptom_observed` is deliberately NOT here —
 * it is an owner-visible health observation by design (see the hidden-case
 * note in get-libreta-face-data.ts).
 *
 * Use as: `where(and(eq(petEvents.petId, pet.id), excludeAuthorityOnlyClause()))`.
 */
export const AUTHORITY_ONLY_EVENT_TYPES = ["outbreak_signal", "disease_reported"] as const;

export function excludeAuthorityOnlyClause() {
  return sql`event_type NOT IN ('outbreak_signal', 'disease_reported')`;
}

export type EventPayloadSummary = {
  primary: string | null;
  secondary: string | null;
};

// es-AR display labels for the 5 Fase 1 corridors (movilidad-jurisdiccional).
// Mirrors lib/reference/cross-border-corridors.ts labels without importing the
// registry — timeline rendering must stay total over historical rows even if
// the registry evolves.
const CORRIDOR_DISPLAY_LABELS: Record<string, string> = {
  chile: "Chile",
  uruguay: "Uruguay",
  brasil: "Brasil",
  ue_espana: "Unión Europea (España)",
  usa: "Estados Unidos",
};

function corridorDisplayLabel(corridorId: string): string {
  return CORRIDOR_DISPLAY_LABELS[corridorId] ?? corridorId;
}

// Curated, whitelisted es-AR key→value view of an event payload for the owner
// timeline (H3, 2026-07-01). Replaces a raw JSON dump on a citizen surface: only
// safe, human fields are emitted — never internal identifiers (*_id), hashes
// (firma_hash, evidence_hash), matched_chip_number, or raw enum codes. Unknown
// event types return [] (no detail section renders).
export function eventPayloadDetails(
  eventType: string,
  payload: unknown,
): Array<{ label: string; value: string; field: string }> {
  const upcasted = upcastPayload(eventType as EventType, payload);
  const p = (upcasted ?? {}) as Record<string, unknown>;
  // `field` — the PAYLOAD KEY this row came from — rides along since WU-J. The
  // switch below has always known it and was throwing it away, which meant a
  // caller that wanted to OFFER A CORRECTION on a curated row had to go back to
  // the raw payload and re-derive the whitelist to know which keys were safe to
  // show. The native correction form now edits exactly these rows, so its field
  // list is the curated list BY CONSTRUCTION instead of by a second copy of this
  // switch. Emitting the key is safe in a way emitting an arbitrary payload is
  // not: every key named here is one this function already decided to render.
  const rows: Array<{ label: string; value: string; field: string }> = [];
  const push = (label: string, key: string, transform?: (v: string) => string) => {
    const v = p[key];
    if (typeof v === "string" && v.length > 0) {
      rows.push({ label, value: transform ? transform(v) : v, field: key });
    } else if (typeof v === "number") {
      rows.push({ label, value: String(v), field: key });
    }
  };
  const pushDate = (label: string, key: string) => {
    const v = p[key];
    if (typeof v === "string" && v.length > 0) {
      // Legacy payloads may carry a bare "YYYY-MM-DD" (midnight UTC = the
      // previous AR day) — anchor those at noon UTC before the AR-pinned
      // render, same guard as pet-compliance.ts::parseNextDue.
      const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? parseDateInput(v) : new Date(v);
      if (d && Number.isFinite(d.getTime())) {
        rows.push({
          label,
          value: d.toLocaleDateString("es-AR", { timeZone: AR_TIME_ZONE }),
          field: key,
        });
      }
    }
  };

  switch (eventType) {
    case "vaccination_administered":
      push("Vacuna", "vaccine_name");
      push("Marca", "brand");
      push("Lote", "batch");
      push("Aplicada por", "administered_by");
      pushDate("Próxima dosis", "next_due_at");
      break;
    case "deworming_administered":
      push("Producto", "product");
      push("Tipo", "type", (v) =>
        v === "internal"
          ? "interno"
          : v === "external"
            ? "externo"
            : v === "both"
              ? "interno + externo"
              : v,
      );
      break;
    case "sterilization_performed":
      push("Procedimiento", "procedure", (v) =>
        v === "castration" ? "castración" : v === "spay" ? "ovariectomía" : v,
      );
      push("Realizada por", "performed_by");
      push("Clínica", "clinic");
      break;
    case "microchip_implanted":
      push("Número", "chip_number");
      push("Implantado por", "implanted_by");
      push("Ubicación", "location_on_body");
      break;
    case "weight_recorded":
      // es-AR comma, never the stored "12.50" dot (lib/utils/format.ts).
      push("Peso", "kg", (v) => formatWeightKg(v) ?? `${v} kg`);
      break;
    case "vet_visit_logged":
      push("Motivo", "reason");
      push("Veterinario", "vet_name");
      push("Clínica", "clinic");
      push("Diagnóstico", "diagnosis");
      break;
    case "note_added":
      push("Nota", "text");
      // kind=adoption_info_requested (T3-A2b): the shelter's message has its
      // own key; legacy rows carry it in `text`, already pushed above.
      push("Pedido de información", "info_request_message");
      break;
    case "post_adoption_checkin":
      // The adopter's "¿Cómo está?" answer. Without this case the detail
      // page said "Sin campos adicionales" and the text the adopter wrote
      // appeared NOWHERE in the UI (9-role external run, 2026-08-18) — a
      // record whose whole content is the answer rendered as if it had none.
      push("¿Cómo está?", "notes");
      break;
    case "dangerous_breed_attested":
      push("Registro", "registry", (v) =>
        v === "caba_4078"
          ? "CABA · Ley 4078"
          : v === "prov_14107"
            ? "Prov. Bs. As. · Ley 14.107"
            : v === "other"
              ? "Otro registro"
              : v,
      );
      break;
    case "movement_recorded": {
      // Whitelisted per sub_kind — never internal ids, never raw enum codes.
      const subKind = typeof p.sub_kind === "string" ? p.sub_kind : null;
      if (subKind === "jurisdiction_changed") {
        push("País de destino", "to_country");
        push("Provincia de destino", "to_province");
        push("Localidad de destino", "to_locality");
        pushDate("Fecha efectiva", "effective_date");
        push("Motivo", "reason");
      } else if (subKind === "cvi_issued") {
        push("Nº de CVI", "cvi_number");
        push("Autoridad emisora", "issuing_authority");
        push("País de origen", "origin_country");
        pushDate("Fecha de emisión", "issued_date");
      } else if (subKind === "transport_recorded") {
        push("Corredor", "corridor_id", corridorDisplayLabel);
        pushDate("Fecha de viaje", "travel_date");
        push("Medio", "mode", (v) =>
          v === "air" ? "aéreo" : v === "land" ? "terrestre" : v === "sea" ? "marítimo" : v,
        );
        push("Motivo", "purpose");
      }
      break;
    }
    default:
      return [];
  }
  return rows;
}

export function eventPayloadSummary(eventType: string, payload: unknown): EventPayloadSummary {
  // Bring every historical payload up to its latest schema version before any
  // field is read. This is the primary read-path hook for the upcaster registry
  // — all timeline and UI callers go through this function.
  const upcasted = upcastPayload(eventType as EventType, payload);
  const p = (upcasted ?? {}) as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = p[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  switch (eventType) {
    case "vaccination_administered": {
      const vaccine = str("vaccine_name");
      const adminBy = str("administered_by");
      const brand = str("brand");
      const tail = [adminBy, brand].filter(Boolean).join(" · ") || null;
      return {
        primary: vaccine ? `Vacuna: ${vaccine}` : null,
        secondary: tail,
      };
    }
    case "deworming_administered": {
      const product = str("product");
      const typeRaw = str("type");
      const typeLabel =
        typeRaw === "internal"
          ? "interno"
          : typeRaw === "external"
            ? "externo"
            : typeRaw === "both"
              ? "interno + externo"
              : null;
      return {
        primary: product ? `Antiparasitario: ${product}` : null,
        secondary: typeLabel,
      };
    }
    case "sterilization_performed": {
      const procedure = str("procedure");
      const performedBy = str("performed_by");
      const clinic = str("clinic");
      const procedureLabel =
        procedure === "castration"
          ? "castración"
          : procedure === "spay"
            ? "ovariectomía"
            : procedure;
      const tail = [performedBy, clinic].filter(Boolean).join(" · ") || null;
      return {
        primary: procedure ? `Esterilización: ${procedureLabel}` : null,
        secondary: tail,
      };
    }
    case "microchip_implanted": {
      const chip = str("chip_number");
      const by = str("implanted_by");
      return {
        primary: chip ? `Microchip implantado · ${chip}` : null,
        secondary: by,
      };
    }
    case "microchip_replaced": {
      const previous = str("previous_chip_number");
      const next = str("new_chip_number");
      const reason = str("reason");
      // new_chip_number === null means revocation (chip retired without
      // replacement). Reads as a separate verb on the timeline.
      if (next === null) {
        return {
          primary: previous ? `Microchip revocado · ${previous}` : "Microchip revocado",
          secondary: reason,
        };
      }
      return {
        primary: next ? `Microchip reemplazado · ${next}` : "Microchip reemplazado",
        secondary: previous ? `Anterior: ${previous}` : reason,
      };
    }
    case "dangerous_breed_attested": {
      const registry = str("registry");
      const registryId = str("registry_id");
      const registryLabel =
        registry === "caba_4078"
          ? "CABA · Ley 4078"
          : registry === "prov_14107"
            ? "Prov. Bs. As. · Ley 14.107"
            : registry === "other"
              ? "Otro registro"
              : null;
      return {
        primary: registryLabel
          ? `Atestación PPP · ${registryLabel}`
          : "Atestación de raza peligrosa",
        secondary: registryId ? `Nº ${registryId}` : null,
      };
    }
    case "weight_recorded": {
      const kg = formatWeightKg(str("kg"));
      return {
        primary: kg ? `Peso: ${kg}` : null,
        secondary: null,
      };
    }
    case "vet_visit_logged": {
      const reason = str("reason");
      const vetName = str("vet_name");
      const clinic = str("clinic");
      const tail = [vetName, clinic].filter(Boolean).join(" · ") || null;
      return {
        primary: reason ? `Visita: ${reason}` : null,
        secondary: tail,
      };
    }
    case "note_added": {
      // An info request's message has its own key since T3-A2b; `text` then
      // holds a fixed label. Legacy rows keep the message in `text`.
      const text = str("info_request_message") ?? str("text");
      const cat = str("category");
      return {
        primary: text ? `Nota: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}` : null,
        secondary: cat ? cat.replace(/_/g, " ") : null,
      };
    }
    case "medication_started": {
      const drugName = str("drug_name");
      const dose = str("dose");
      const frequency = str("frequency");
      const secondary = [dose, frequency].filter(Boolean).join(" · ") || null;
      return {
        primary: drugName ? `Inicio: ${drugName}` : null,
        secondary,
      };
    }
    case "medication_stopped": {
      const reason = str("reason");
      return {
        primary: "Fin de medicación",
        secondary: reason,
      };
    }
    case "medication_dose_taken": {
      const scheduledFor = str("scheduled_for");
      return {
        primary: "Dosis dada",
        secondary: scheduledFor ? `Programada para ${scheduledFor}` : null,
      };
    }
    case "death_recorded": {
      const cause = str("cause");
      const causeDetail = str("cause_detail");
      const disposition = str("disposition_method");
      const facility = str("facility");
      const diseaseCode = str("disease_code");
      const isReportablePayload = p.is_reportable === true;
      const deathAtClinic = p.death_at_clinic === true;
      const clinicName = str("clinic_name");
      const vetDecidedAlone = p.vet_decided_alone === true;

      const causeLabel: Record<string, string> = {
        known: "Conocida",
        unknown: "Desconocida",
        natural: "Natural / vejez",
        disease: "Enfermedad",
        accident: "Accidente",
        euthanasia: "Eutanasia",
        sudden: "Repentina",
        violent: "Violenta",
        other: "Otra",
      };
      const dispositionLabel: Record<string, string> = {
        cremation_collective: "Cremación colectiva",
        cremation_individual_ashes: "Cremación individual (cenizas)",
        authorized_cemetery: "Cementerio autorizado",
        owner_burial: "Sepultura por el propietario",
        household_waste: "Residuos no especiales",
        rendering: "Reciclaje sanitario",
        unknown: "No sé",
        // Legacy values from events recorded before the enum split — keep rendering them.
        cremation: "Cremación",
        burial: "Entierro",
      };

      // When cause is "disease", use the resolved disease label if available.
      let primary: string;
      if (cause === "disease") {
        const diseaseDef = findDisease(diseaseCode);
        const diseaseLabel = diseaseDef?.label ?? causeLabel.disease;
        primary = `Fallecimiento · ${diseaseLabel}`;
      } else {
        const showCause = cause && cause !== "other" && causeLabel[cause];
        primary = showCause ? `Fallecimiento · ${causeLabel[cause]}` : "Fallecimiento";
      }

      const dispositionStr = disposition ? (dispositionLabel[disposition] ?? disposition) : null;
      const clinicStr = deathAtClinic
        ? clinicName
          ? `En clínica: ${clinicName}`
          : "En clínica"
        : null;
      const vetAloneStr = vetDecidedAlone ? "Vet decidió sin contacto con propietario" : null;
      let secondary =
        [dispositionStr, facility, clinicStr, vetAloneStr].filter(Boolean).join(" · ") ||
        causeDetail;

      if (isReportablePayload) {
        const badge = "Reportable a autoridad sanitaria";
        secondary = secondary ? `${secondary} · ${badge}` : badge;
      }

      return { primary, secondary: secondary || null };
    }
    case "clinical_info_logged": {
      const subKind = str("sub_kind");
      const title = str("title");
      // One entry per sub_kind in `clinicalInfoLogged` (lib/events/event-schemas.ts).
      // The schema had SEVEN and this map had five, so `disease_diagnosis` and
      // `pregnancy` fell through the `?? subKind` fallback and printed a raw
      // English identifier into a Spanish medical record: the staging
      // clickthrough of 2026-08-13 read "Información clínica · pregnancy" in a
      // pet's timeline. The fallback is what made it silent — it produces
      // something plausible-looking for anything, so a missing label never
      // looks like a bug. `__tests__/clinical-sub-kind-labels.test.ts` now
      // fails if the two lists drift apart again.
      const subKindLabels: Record<string, string> = {
        lab_work: "Laboratorio",
        imaging: "Imagen",
        surgery: "Cirugía",
        allergy_detection: "Alergia",
        disease_diagnosis: "Diagnóstico",
        pregnancy: "Embarazo",
        other: "Otro",
      };
      const subKindLabel = subKind ? (subKindLabels[subKind] ?? subKind) : null;
      return {
        primary: subKindLabel ? `Información clínica · ${subKindLabel}` : "Información clínica",
        secondary: title ? (title.length > 60 ? `${title.slice(0, 60)}…` : title) : null,
      };
    }
    case "maltreatment_reported": {
      const kindRaw = str("kind");
      const description = str("description");
      const kindLabel = kindRaw ? welfareReportKindLabel(kindRaw) : null;
      return {
        primary: kindLabel ? `Denuncia: maltrato · ${kindLabel}` : "Denuncia: maltrato",
        secondary: description
          ? description.length > 60
            ? `${description.slice(0, 60)}…`
            : description
          : null,
      };
    }
    case "abandonment_reported": {
      const description = str("description");
      return {
        primary: "Denuncia: abandono",
        secondary: description
          ? description.length > 60
            ? `${description.slice(0, 60)}…`
            : description
          : null,
      };
    }
    case "symptom_observed": {
      const symptoms = str("symptoms");
      return {
        primary: "Síntomas observados",
        secondary: symptoms
          ? symptoms.length > 60
            ? `${symptoms.slice(0, 60)}…`
            : symptoms
          : null,
      };
    }
    case "status_changed": {
      const toStatus = str("to_status");
      // Prefer the canonical `location_description` key; fall back to the
      // legacy `last_known_location` for events written before the rename.
      const loc = str("location_description") ?? str("last_known_location");
      const reason = str("reason");
      let primary: string | null = null;
      if (toStatus === "lost") primary = "Marcada como perdida";
      else if (toStatus === "active") primary = "Marcada como encontrada";
      return {
        primary,
        secondary: loc || reason,
      };
    }
    case "foster_proposal_resolved": {
      const outcome = str("outcome");
      const map: Record<string, string> = {
        accepted: "Propuesta de tránsito aceptada",
        rejected: "Propuesta de tránsito rechazada",
        cancelled: "Propuesta de tránsito cancelada",
        expired: "Propuesta de tránsito expirada",
      };
      return {
        primary: (outcome && map[outcome]) || "Propuesta de tránsito resuelta",
        secondary: str("response_notes") ?? str("cancellation_reason") ?? null,
      };
    }
    case "adoption_reversed": {
      const actor = str("actor");
      const map: Record<string, string> = {
        shelter: "Adopción revertida por el refugio",
        adopter: "Adopción revertida por el adoptante",
        court: "Adopción revertida por orden judicial",
      };
      return {
        primary: (actor && map[actor]) || "Adopción revertida",
        secondary: str("reason"),
      };
    }
    case "adoption_application_resolved": {
      const outcome = str("outcome");
      const auto = str("auto_generated") === "true";
      let primary: string;
      if (outcome === "approved") primary = "Postulación aprobada";
      else if (outcome === "rejected" && auto)
        primary = "Postulación cerrada (otra adopción se finalizó)";
      else if (outcome === "rejected") primary = "Postulación no avanzó";
      else primary = "Postulación resuelta";
      return { primary, secondary: str("notes") };
    }
    case "ownership_claimed":
      return { primary: "Mascota reclamada", secondary: null };
    case "movement_recorded": {
      const subKind = str("sub_kind");
      if (subKind === "jurisdiction_changed") {
        const fromParts = [str("from_locality"), str("from_province")].filter(Boolean);
        const toParts = [str("to_locality"), str("to_province")].filter(Boolean);
        const from = fromParts.join(", ") || str("from_country");
        const to = toParts.join(", ") || str("to_country");
        return {
          primary: "Cambio de jurisdicción",
          secondary: from && to ? `${from} → ${to}` : (to ?? null),
        };
      }
      if (subKind === "cvi_issued") {
        const number = str("cvi_number");
        const authority = str("issuing_authority");
        return {
          primary: "CVI internacional registrado",
          secondary: [number, authority].filter(Boolean).join(" · ") || null,
        };
      }
      if (subKind === "transport_recorded") {
        const corridorId = str("corridor_id");
        const travelDate = str("travel_date");
        const corridorLabel = corridorId ? corridorDisplayLabel(corridorId) : null;
        return {
          primary: "Viaje registrado",
          secondary: [corridorLabel, travelDate].filter(Boolean).join(" · ") || null,
        };
      }
      return { primary: "Movilidad registrada", secondary: null };
    }
    case "custody_transfer_cancelled": {
      const cancelledBy = str("cancelled_by");
      const reason = str("reason");
      const primaryMap: Record<string, string> = {
        owner_reject: "Rechazada por el dueño/a",
        actor_cancel: "Cancelada por quien la propuso",
        org_reject: "Rechazada por la organización",
        auto_cancel: "Cancelada automáticamente",
      };
      return {
        primary: (cancelledBy && primaryMap[cancelledBy]) || "Propuesta cancelada",
        secondary: reason,
      };
    }
    default:
      return { primary: null, secondary: null };
  }
}

/**
 * Event types whose `secondary` is owner-supplied free text describing WHERE the
 * animal was last seen. For a lost pet that text is routinely the owner's own
 * address ("last seen" = where it got out).
 */
const LOCATION_BEARING_EVENT_TYPES = new Set(["status_changed"]);

/**
 * The "update last-seen location" flow does NOT write a second status_changed —
 * it writes note_added(kind="sighting") scoped to the open lost case
 * (update-lost-last-seen-use-case.ts), whose `text` is composed as
 * `${locationDescription} — ${reason}`. So the same address reaches the same
 * public page through a different event type, and lands in `primary` rather
 * than `secondary`. Redacting only status_changed would have closed the front
 * door and left this one open.
 */
function isLostSightingNote(eventType: string, payload: unknown): boolean {
  if (eventType !== "note_added") return false;
  const p = payload as Record<string, unknown> | null;
  return typeof p === "object" && p !== null && p.kind === "sighting";
}

/**
 * Event types whose `secondary` is the free-text body of a cruelty complaint.
 */
const COMPLAINT_TEXT_EVENT_TYPES = new Set(["maltreatment_reported", "abandonment_reported"]);

/**
 * Summary for a case timeline entry, with the redactions a PUBLIC (anonymous)
 * viewer requires. Non-public viewers get eventPayloadSummary unchanged.
 *
 * WHY THIS EXISTS. /casos/[publicCode] is readable by anyone holding the CAS
 * code — canReadCase(null) admits anonymous viewers for lost_pet_episode and
 * welfare_denuncia. It rendered every event through eventPayloadSummary with no
 * viewer distinction, which leaked two things:
 *
 *   1. The last-seen location of a lost pet, even when the owner had turned
 *      "show the location publicly" OFF. The credential (/p/[publicToken])
 *      honours that toggle at the SELECT — so the owner sees the field hidden
 *      where they set it and has no reason to suspect the case page shows it.
 *      Silently defeating an opt-in privacy control is the whole of the bug.
 *   2. The description of a cruelty complaint. The public receipt
 *      (/denuncias/codigo/[code]) already shows this to a DEN-code holder, so
 *      the exposure is narrower — but a second anonymous surface emitting
 *      complaint prose is not something to add by omission.
 *
 * `discloseLastLocation` must come from the pet's CURRENT
 * disclose_last_location_when_lost column, not the disclosure_prefs_snapshot in
 * the event payload: the snapshot records what the preference was at lost-time,
 * so honouring it would ignore an owner who turned disclosure off afterwards.
 * Same source as the credential — one preference, one meaning.
 */
export function caseTimelineSummary(
  eventType: string,
  payload: unknown,
  opts: { isPublic: boolean; discloseLastLocation: boolean },
): EventPayloadSummary {
  const summary = eventPayloadSummary(eventType, payload);
  if (!opts.isPublic) return summary;

  if (LOCATION_BEARING_EVENT_TYPES.has(eventType) && !opts.discloseLastLocation) {
    // `secondary` is `location_description || reason` — indistinguishable once
    // joined, so the whole field goes. The primary ("Marcada como perdida")
    // carries the fact, which is the point of a public case page.
    return { primary: summary.primary, secondary: null };
  }

  // note_added is FREE TEXT, so it is allow-listed rather than pattern-matched.
  //
  // The first version of this function redacted the lost-sighting note and let
  // every other note through. That was redaction BY COLUMN — the CaseDetailView
  // hides the `notes` column and this hid one payload shape — and free text does
  // not respect column boundaries. A concrete leak got through it: when two orgs
  // report the same animal, create-org-welfare-report.ts writes a
  // note_added(category:"system") whose text names the reporting organisation,
  // attached by caseId to an anonymously-readable welfare_denuncia case.
  //
  // The org's identity is public by design elsewhere (it appears as a case
  // party), so that instance is marginal — but the DEFAULT was the bug: any
  // future free-text note attached to an anon-readable case leaked on arrival,
  // with no one having decided it should. Now nothing free-form reaches an
  // anonymous viewer unless it is listed here.
  if (eventType === "note_added") {
    if (!isLostSightingNote(eventType, payload)) {
      // Not on the allow-list: the entry still appears (the timeline should not
      // develop silent holes) but says only that something was recorded.
      return { primary: "Nota registrada en el caso", secondary: null };
    }
    if (!opts.discloseLastLocation) {
      // Allow-listed, but the address is in `primary` ("Nota: {text}"), so the
      // fact has to be restated rather than merely stripped — an empty entry
      // would read as a rendering bug on a page whose purpose is a legible
      // timeline.
      return { primary: "Actualización de la última ubicación conocida", secondary: null };
    }
  }

  if (COMPLAINT_TEXT_EVENT_TYPES.has(eventType)) {
    return { primary: summary.primary, secondary: null };
  }

  return summary;
}
