// `GET /api/v1/pets/{publicToken}?face=former_owner` — the read-only face a
// FORMER owner keeps while an official custody episode is open
// (notificaciones-destinos, 2026-10).
//
// THE RULE IS THE WEB'S. PO decision 2026-07-18: «El ex-dueño conserva LECTURA
// durante el proceso [de custodia oficial / decomiso]. Si lo pierde
// [definitivamente], también los permisos. Si se lo devuelve, nunca se le fue.»
// `/mis-mascotas/{token}` has rendered that face since then
// (`getFormerOwnerReadAccess`, lib/infra/pet-access.ts); the bearer door never
// called it, so the person told "decomisaron a tu mascota" tapped the
// notification on the phone and got "No disponible". The same resolver now
// answers here, and nothing else does: it grants no write and carries nothing
// the web's read-only view does not show.
//
// OPT-IN BY QUERY PARAMETER, and that is the compatibility story rather than a
// style choice. Builds already installed parse every 200 from this URL as
// `OwnerPetDetailV1`; handing them this narrower shape would crash the screen
// where today they show a refusal. A current build asks for this face only after
// the ordinary read answered `not_found`, and with the parameter the server
// answers ONLY this face (or `not_found`), never the holder's detail.

export const FORMER_OWNER_PET_READ_PAYLOAD_VERSION = 1;

/** Same window as the owner detail: custody state moves on the authority's clock. */
export const FORMER_OWNER_PET_READ_STALE_AFTER_MS = 60_000;

/** The query parameter, and its one value. */
export const FORMER_OWNER_FACE_PARAM = "face";
export const FORMER_OWNER_FACE_VALUE = "former_owner";

export type FormerOwnerPetReadV1 = {
  payloadVersion: typeof FORMER_OWNER_PET_READ_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  face: "former_owner_during_custody";
  pet: {
    publicToken: string;
    name: string;
    species: string;
    breed: string | null;
    sex: "male" | "female" | "unknown" | null;
    /** ISO date (YYYY-MM-DD) or null. */
    dateOfBirth: string | null;
  };
  /** The open custody_episode. Its code is shown, not linked: the case is the authority's. */
  custodyCase: { publicCode: string };
};
