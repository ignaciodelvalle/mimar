// Pure helpers behind the unresolved-place queue's decision context: what the
// admin needs next to the "Resolver el lugar" button (distance from the pin,
// the subject's kind and the creator's role in es-AR words). No I/O.

import { WELFARE_KIND_LABEL } from "@/src/modules/cases/domain/opened-reason-labels";

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km between two WGS84 points. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "850 m" under a kilometre, "12,3 km" under 100, "148 km" beyond. */
export function formatDistanceKm(km: number): string {
  if (km < 0.1) return "menos de 100 m";
  if (km < 1) return `${Math.round(km * 100) * 10} m`;
  if (km < 100) return `${km.toFixed(1).replace(".", ",")} km`;
  return `${Math.round(km)} km`;
}

type RawCandidate = {
  localityId: string;
  name: string;
  department: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
};

export type CandidateWithDistance = {
  localityId: string;
  name: string;
  department: string | null;
  /** Null when there is no pin or the candidate has no centroid. */
  distanceKm: number | null;
};

function finite(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Candidates with their distance from the pin, nearest first. Without a pin
 * the input order (department, then id) is kept; a candidate with no centroid
 * sorts after the ones that have a distance.
 */
export function rankCandidates(
  candidates: RawCandidate[],
  pin: { lat: number; lng: number } | null,
): CandidateWithDistance[] {
  const withDistance = candidates.map((c, index) => {
    const lat = finite(c.latitude);
    const lng = finite(c.longitude);
    const distanceKm = pin && lat !== null && lng !== null ? haversineKm(pin, { lat, lng }) : null;
    return {
      index,
      row: { localityId: c.localityId, name: c.name, department: c.department, distanceKm },
    };
  });
  if (pin) {
    withDistance.sort((x, y) => {
      if (x.row.distanceKm === null && y.row.distanceKm === null) return x.index - y.index;
      if (x.row.distanceKm === null) return 1;
      if (y.row.distanceKm === null) return -1;
      return x.row.distanceKm - y.row.distanceKm || x.index - y.index;
    });
  }
  return withDistance.map((x) => x.row);
}

const CASE_KIND_WORDS: Record<string, string> = {
  bite_incident: "Mordedura",
  lost_pet_episode: "Mascota perdida",
  welfare_denuncia: "Denuncia de maltrato",
  adoption_listing: "Publicación de adopción",
  adoption_application: "Solicitud de adopción",
  custody_dispute: "Disputa de tenencia",
  foster_placement: "Tránsito",
  custody_episode: "Custodia",
  custody_transfer_handshake: "Traspaso de custodia",
  foster_proposal: "Propuesta de tránsito",
  outbreak_investigation: "Investigación de brote",
  microchip_remediation: "Regularización de chip",
  rehome_request: "Pedido de reubicación",
};

/** What the subject is, in es-AR words ("Mordedura", "Denuncia: abandono"). */
export function subjectKindLabel(
  subjectTable: "cases" | "welfare_reports",
  kind: string | null,
): string {
  if (subjectTable === "welfare_reports") {
    const word = kind ? (WELFARE_KIND_LABEL[kind] ?? kind) : null;
    return word ? `Denuncia: ${word}` : "Denuncia";
  }
  if (!kind) return "Caso";
  return CASE_KIND_WORDS[kind] ?? "Caso";
}

const CREATOR_ROLE_WORDS: Record<string, string> = {
  owner: "Dueño/a",
  vet: "Veterinario/a",
  govt: "Autoridad pública",
  admin: "Administración",
  national: "Autoridad nacional",
};

/**
 * Who created the subject, by ROLE only (never a name). An organization is
 * named as such; no user and no organization reads as anonymous for a
 * denuncia and as the system for a case.
 */
export function creatorLabel(input: {
  subjectTable: "cases" | "welfare_reports";
  role: string | null;
  viaOrganization: boolean;
}): string {
  if (input.viaOrganization) return "Organización";
  if (input.role) return CREATOR_ROLE_WORDS[input.role] ?? input.role;
  return input.subjectTable === "welfare_reports" ? "Anónimo" : "Sistema";
}
