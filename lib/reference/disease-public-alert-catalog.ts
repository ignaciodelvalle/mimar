// Owner-facing public-health alert catalog (spec
// 2026-05-19-eno-vet-direct-report-and-owner-alerts §5).
//
// Subset of reportable diseases that, by zoonotic risk, justify
// overriding the surveillance D1 "owner never sees diagnoses" rule.
// When a `symptom_observed` matches one of these (with severity >=
// high) or a vet emits a `clinical_info_logged(sub_kind='disease_diagnosis')`
// for one, the owner gets a notification with curated copy + a CTA
// linking to public health info.
//
// The list is small, closed, and conservatively chosen. Adding to it
// should require sign-off from a vet + epidemiologist.
//
// Diseases intentionally NOT here (per spec §5):
//   - ANY stigma-sensitive disease (ENO catalog `stigmaSensitive`, ENO-D4):
//     visceral_leishmaniasis, canine_brucellosis. PO S8 (2026-09-26): the vet
//     communicates those, never an automatic alert. The leishmaniasis entry
//     that used to be here told the owner "fue diagnosticado" and overrode that
//     policy (health audit #8); getPublicAlertForDisease refuses the class, so
//     re-adding an entry cannot bring the alert back.
//   - canine_brucellosis (low household transmission risk)
//   - toxoplasmosis (general-knowledge population, not specific to pet event)
//   - parvovirus / distemper / FeLV / FIV (no zoonotic component)

import type { Notification } from "@/db";
import { diseaseCodeToEnoCode, getEnoDisease } from "@/src/modules/surveillance/domain/eno-catalog";

export type OwnerAlertSeverity = Notification["severity"];

export interface PublicHealthAlert {
  /** FK-by-string to DISEASES.code. */
  diseaseCode: string;
  /** Notification title (es-AR). Supports `{{pet_name}}` placeholder. */
  ownerNotificationTitle: string;
  /** Notification body (es-AR). Supports `{{pet_name}}` placeholder. */
  ownerNotificationBody: string;
  ownerNotificationSeverity: OwnerAlertSeverity;
  ctaLabel: string;
  ctaUrl: string;
  /** Internal rationale captured here for audit; not shown to the user. */
  rationale: string;
}

export const PUBLIC_ALERT_DISEASES: readonly PublicHealthAlert[] = [
  {
    diseaseCode: "rabies_confirmed",
    ownerNotificationTitle: "URGENTE — Caso confirmado de rabia en {{pet_name}}",
    ownerNotificationBody:
      "Se confirmó un caso de rabia en {{pet_name}}. La rabia es 100% mortal sin profilaxis post-exposición humana (APR). Si tuviste contacto con saliva del animal, mordedura, o exposición de mucosas, consultá INMEDIATAMENTE al centro APR más cercano (Instituto Pasteur CABA: 011-4953-2826). No esperes síntomas.",
    ownerNotificationSeverity: "urgent",
    ctaLabel: "Información oficial — Min. Salud",
    ctaUrl: "https://www.argentina.gob.ar/salud/glosario/rabia",
    rationale:
      "Rabia: mortalidad 100% sin APR. Owner es la primera persona en riesgo. Silence sería negligencia.",
  },
  {
    diseaseCode: "rabies_suspected",
    ownerNotificationTitle: "Atención — Sospecha de rabia en {{pet_name}}",
    ownerNotificationBody:
      "Se detectaron síntomas compatibles con rabia en {{pet_name}}. La rabia es 100% mortal sin profilaxis post-exposición. Mientras se confirma el diagnóstico, mantené distancia, evitá contacto con saliva, y consultá a tu veterinario y al centro APR si hubo exposición.",
    ownerNotificationSeverity: "urgent",
    ctaLabel: "Información oficial — Min. Salud",
    ctaUrl: "https://www.argentina.gob.ar/salud/glosario/rabia",
    rationale:
      "Sospecha de rabia tiene el mismo riesgo público que confirmación mientras se confirma. APR pre-emptive es protocolo standard.",
  },
  {
    diseaseCode: "leptospirosis",
    ownerNotificationTitle: "Posible leptospirosis en {{pet_name}} — precauciones",
    ownerNotificationBody:
      "Síntomas o diagnóstico compatible con leptospirosis en {{pet_name}}. Es una bacteria que infecta humanos por contacto con orina infectada. Lavate las manos siempre después de tocar a tu mascota, usá guantes si limpiás su orina o heces, y consultá a tu médico si presentás fiebre, dolor muscular, o ictericia.",
    ownerNotificationSeverity: "warning",
    ctaLabel: "Sobre leptospirosis",
    ctaUrl: "https://www.argentina.gob.ar/salud/glosario/leptospirosis",
    rationale:
      "Zoonosis bacteriana con transmisión directa por contacto con orina. Protocolo de manejo doméstico es preventible si owner sabe.",
  },
  {
    diseaseCode: "hydatidosis",
    ownerNotificationTitle: "Hidatidosis detectada en {{pet_name}}",
    ownerNotificationBody:
      "{{pet_name}} podría estar infectado con hidatidosis (parásito Echinococcus). Es una zoonosis grave en humanos. Manejá las heces con cuidado (bolsa cerrada), lavate las manos con jabón después de tocarlo, y consultá a tu médico para evaluación. El tratamiento del animal lo indica tu veterinario.",
    ownerNotificationSeverity: "warning",
    ctaLabel: "Sobre hidatidosis",
    ctaUrl: "https://www.argentina.gob.ar/salud/glosario/hidatidosis",
    rationale:
      "Echinococcosis transmite huevos por heces. Riesgo doméstico real si owner no sabe manejar las deposiciones.",
  },
  {
    diseaseCode: "anthrax",
    ownerNotificationTitle: "URGENTE — Carbunclo (ántrax) en {{pet_name}}",
    ownerNotificationBody:
      "Se detectó carbunclo en {{pet_name}}. Es una zoonosis bacteriana grave. NO toques al animal sin EPP, mantené distancia, llamá a tu veterinario y al servicio de zoonosis local INMEDIATAMENTE. Las esporas pueden contaminar el entorno.",
    ownerNotificationSeverity: "urgent",
    ctaLabel: "Información oficial — Min. Salud",
    ctaUrl: "https://www.argentina.gob.ar/salud/glosario/carbunclo",
    rationale: "Carbunclo: riesgo crítico para humanos, requiere manejo profesional inmediato.",
  },
  {
    diseaseCode: "tuberculosis",
    ownerNotificationTitle: "Posible tuberculosis en {{pet_name}}",
    ownerNotificationBody:
      "Síntomas o diagnóstico compatible con tuberculosis en {{pet_name}}. Es una zoonosis transmitida por contacto cercano y vía respiratoria. Consultá a tu médico para evaluación, especialmente si convivís con personas inmunocomprometidas o niños pequeños.",
    ownerNotificationSeverity: "warning",
    ctaLabel: "Sobre tuberculosis zoonótica",
    ctaUrl: "https://www.argentina.gob.ar/salud/glosario/tuberculosis",
    rationale:
      "TB cross-species ocurre. Owner debe saber para evaluación clínica humana, sobre todo con inmunocomprometidos en casa.",
  },
];

const ALERT_INDEX = new Map(PUBLIC_ALERT_DISEASES.map((a) => [a.diseaseCode, a]));

/**
 * The curated alert for a disease, or null. ALWAYS null for a stigma-sensitive
 * disease (PO S8): the owner hears it from the vet, never from an automatic
 * notification — whatever the curated list says.
 */
export function getPublicAlertForDisease(diseaseCode: string): PublicHealthAlert | null {
  if (getEnoDisease(diseaseCodeToEnoCode(diseaseCode))?.stigmaSensitive) return null;
  return ALERT_INDEX.get(diseaseCode) ?? null;
}

/**
 * Renders a public-health alert with placeholders substituted. Returns
 * the shape `notifications` accepts (title / body / severity / cta).
 */
export function renderPublicAlertCopy(
  alert: PublicHealthAlert,
  vars: { pet_name: string },
): { title: string; body: string; severity: OwnerAlertSeverity; ctaLabel: string; ctaUrl: string } {
  const sub = (s: string) => s.replace(/\{\{pet_name\}\}/g, vars.pet_name);
  return {
    title: sub(alert.ownerNotificationTitle),
    body: sub(alert.ownerNotificationBody),
    severity: alert.ownerNotificationSeverity,
    ctaLabel: alert.ctaLabel,
    ctaUrl: alert.ctaUrl,
  };
}
