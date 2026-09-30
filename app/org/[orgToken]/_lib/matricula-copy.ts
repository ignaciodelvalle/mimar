// matricula-copy — the credential-gate wording shared by server pages and the
// client Permisos matrix (portal-vet-p0 D12). ZERO imports on purpose: the
// matrix is a "use client" component, and anything heavier here (the domain
// capabilities module pulls in the DB schema) would ride into its bundle.

/** Where a vet verifies their matrícula. */
export const MATRICULA_UPGRADE_HREF = "/cuenta/upgrade";

/** The member's row pill, the admin matrix cell and the miembros row say the same thing. */
export const NEEDS_MATRICULA_LABEL = "Requiere matrícula verificada";

/** miembros row: the event-write toggle is replaced by this for a vet_individual. */
export const BY_MATRICULA_LABEL = "Por matrícula";
