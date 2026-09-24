// Types for the upgrade use-cases (vet role upgrade, org creation).
//
// Vet upgrade input. Two location concepts kept separate per the spec:
//
// - matriculaJurisdiccion: where the matricula was issued (the registry to
//   check). Lives in the payload.
// - operationalProvince / operationalLocality: where the vet operates,
//   which routes the approval request to the right govt (or admin as
//   fallback). Lives on approval_requests.jurisdiction_*.
//
// They are often the same value but not always — a vet licensed in CABA
// may operate primarily in Pilar (Buenos Aires province).
export type VetUpgradeInput = {
  matriculaNumber: string;
  matriculaJurisdiccion: string;
  operationalProvince: string;
  operationalLocality: string;
  especialidad?: string | null;
  anosExperiencia?: number | null;
};

export type CreateOrganizationInput = {
  name: string;
  legalName: string;
  orgType: "clinic" | "shelter" | "rescue_network" | "sanitary_authority" | "other";
  cuit?: string | null;
  email: string;
  phone?: string | null;
  jurisdictionProvince: string;
  jurisdictionLocality: string;
  personeriaJuridicaNumber?: string | null;
};

export type UpgradeFormState = {
  error: string | null;
  ok?: boolean;
  organizationId?: string;
  /** N3 post-action navigation — client performs full-page nav (see useActionRedirect). */
  redirectTo?: string | null;
  // When a prerequisite is missing, the UI renders a CTA instead of the
  // generic error paragraph. See docs/patterns/petition-prerequisites.md.
  missingPrereq?: "dni";
  prereqUrl?: string;
};
