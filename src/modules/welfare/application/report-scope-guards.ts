// Jurisdiction scope guards for the welfare (denuncia) operator circuit.
//
// Extracted from src/modules/welfare/actions.ts, which sat exactly on its
// file-size fence. Behaviour is byte-identical: same lookup, same subsumption
// rule, same uniform "not found" for out-of-scope. Only the two result shapes
// differ, and that difference is preserved — callers of `loadAndVerifyScope`
// destructure `{ ok: false, error }`, callers of `loadInScopeReport` check for
// `"error" in result`. Collapsing them into one shape is a separate change with
// its own call-site sweep; this move deliberately changes nothing.
//
// UNIFORM "NOT FOUND" IS THE SECURITY PROPERTY, not politeness: a govt operator
// who guesses a report UUID from another jurisdiction must not learn that it
// exists. Both guards return the same message for "no such row" and "not
// yours", and no caller may widen that.

import type { WelfareReport } from "@/db";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";

import type { WelfareRepository } from "../infrastructure/welfare-repository";

type ScopeActor = { id: string; role: "admin" | "govt" };
type Jurisdictions = { province: string; locality: string }[];
type RepoPort = Pick<WelfareRepository, "findById">;

function inScope(row: WelfareReport, actor: ScopeActor, jurisdictions: Jurisdictions): boolean {
  if (actor.role !== "govt") return true;
  // Subsumption-aware scope check (whole-province assignments govern every
  // barrio) — MUST match the triage queue list and the detail page, so the full
  // operator circuit (assign/triage/close/derive/MPF) resolves any denuncia the
  // queue shows. See jurisdictionScopeContains.
  return jurisdictionScopeContains(
    jurisdictions,
    row.jurisdictionProvince,
    row.jurisdictionLocality,
  );
}

export async function loadInScopeReport(
  repo: RepoPort,
  reportId: string,
  actor: ScopeActor,
  jurisdictions: Jurisdictions,
): Promise<{ row: WelfareReport } | { error: string }> {
  const row = await repo.findById(reportId);
  if (!row) return { error: "Denuncia no encontrada." };
  if (!inScope(row, actor, jurisdictions)) return { error: "Denuncia no encontrada." };
  return { row };
}

export async function loadAndVerifyScope(
  repo: RepoPort,
  reportId: string,
  actor: ScopeActor,
  jurisdictions: Jurisdictions,
): Promise<{ row: WelfareReport } | { ok: false; error: string }> {
  const row = await repo.findById(reportId);
  if (!row) return { ok: false, error: "Denuncia no encontrada." };
  if (!inScope(row, actor, jurisdictions)) return { ok: false, error: "Denuncia no encontrada." };
  return { row };
}
