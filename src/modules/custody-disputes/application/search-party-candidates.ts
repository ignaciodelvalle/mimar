// Use-case: searchPartyCandidatesUseCase
//
// Powers AddPartyForm's real search/select picker (V9 usability fix — replaces
// the raw-UUID-paste-then-verify flow with a name search over the SAME
// audited queries the /gob/usuarios and /gob/organizaciones rosters use).
//
// Reuses searchUsers/searchOrganizations (lib/infra/admin-search.ts) verbatim
// — no new fetch logic — under the same dispute-scoped tenant-isolation gate
// lookupTransferTargetUseCase already enforces: the caller must be an
// admin, or a govt agent whose jurisdiction covers THIS dispute. Without that
// gate a govt caller could search users/orgs outside their jurisdiction via
// this form even though the dispute itself is out of scope for them.
//
// Once bound to the dispute, the jurisdiction scoping searchUsers/
// searchOrganizations already apply for a govt caller (admin: universal)
// governs which candidates surface — same "prefer showing LESS" posture as
// /gob/usuarios and /gob/organizaciones.

import { eq } from "drizzle-orm";

import { custodyDisputes, db } from "@/db";
import type { CustodyDispute } from "@/db";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import { roleLabel } from "@/lib/domain/role-labels";
import { searchOrganizations, searchUsers } from "@/lib/infra/admin-search";

import type {
  PartyCandidate,
  SearchPartyCandidatesInput,
  SearchPartyCandidatesResult,
} from "../domain/types";

type Session = {
  profile: { role: string };
  jurisdictions: { province: string; locality: string }[];
};

// Same label set as app/gob/organizaciones/page.tsx's ORG_TYPE_LABELS.
const ORG_TYPE_LABELS: Record<string, string> = {
  clinic: "Clínica",
  shelter: "Refugio",
  rescue_network: "Red de rescate",
  sanitary_authority: "Autoridad sanitaria",
  other: "Otro",
};

// Below this length the query is too broad to search — mirrors the
// MIN_QUERY_LENGTH convention used by LocalityPickerAcross/OpOmnibox.
const MIN_QUERY_LENGTH = 2;

function isGovtInScope(
  jurisdictions: { province: string; locality: string }[],
  dispute: Pick<CustodyDispute, "jurisdictionProvince" | "jurisdictionLocality">,
): boolean {
  return jurisdictionScopeContains(
    jurisdictions,
    dispute.jurisdictionProvince,
    dispute.jurisdictionLocality,
  );
}

export async function searchPartyCandidatesUseCase(
  session: Session,
  input: SearchPartyCandidatesInput,
): Promise<SearchPartyCandidatesResult> {
  if (session.profile.role !== "admin" && session.profile.role !== "govt") {
    return { error: "No tenés permiso para esta acción." };
  }

  const disputeToken = input.disputeToken.trim();
  if (!disputeToken) return { error: "Falta la disputa." };

  const [dispute] = await db
    .select({
      jurisdictionProvince: custodyDisputes.jurisdictionProvince,
      jurisdictionLocality: custodyDisputes.jurisdictionLocality,
    })
    .from(custodyDisputes)
    .where(eq(custodyDisputes.publicToken, disputeToken))
    .limit(1);
  if (!dispute) return { error: "Disputa no encontrada." };
  if (session.profile.role === "govt" && !isGovtInScope(session.jurisdictions, dispute)) {
    return { error: "Esta disputa está fuera de tu jurisdicción." };
  }

  const query = input.query.trim();
  if (query.length < MIN_QUERY_LENGTH) return { candidates: [] };

  if (input.kind === "user") {
    // UserSearchScope: admin carries no jurisdictions field at all.
    const userScope =
      session.profile.role === "admin"
        ? ({ role: "admin" } as const)
        : ({ role: "govt", jurisdictions: session.jurisdictions } as const);
    const users = await searchUsers(query, userScope);
    const candidates: PartyCandidate[] = users.map((u) => ({
      id: u.id,
      displayName: u.displayName,
      secondaryLabel: roleLabel(u.role),
      flagLabel: u.deactivatedAt !== null ? "Cuenta desactivada" : null,
    }));
    return { candidates };
  }

  // searchOrganizations' scope type always carries jurisdictions (unused when
  // role is "admin" — see admin-search.ts's scopePredicate branch).
  const orgScope = {
    role: session.profile.role as "admin" | "govt",
    jurisdictions: session.jurisdictions,
  };
  const { items } = await searchOrganizations(query, orgScope);
  const candidates: PartyCandidate[] = items.map((o) => ({
    id: o.id,
    displayName: o.displayName,
    secondaryLabel: ORG_TYPE_LABELS[o.orgType] ?? o.orgType,
    flagLabel: o.verified ? null : "Organización sin verificar",
  }));
  return { candidates };
}
