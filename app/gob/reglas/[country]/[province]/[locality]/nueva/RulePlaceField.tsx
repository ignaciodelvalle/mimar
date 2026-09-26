"use client";

// The place a new rule is keyed on, by id (localidades-por-id D4).
//
// The rules wizard knows which catalogue row the person picked (the INDEC id
// the locality picker resolved) — the name alone cannot tell Mechita (partido
// Alberti) from Mechita (partido Bragado). Every rule form renders this field
// next to its jurisdiction names; the wizard provides the value through
// context, so the per-type forms need no new props. With no provider (the
// URL-addressed /nueva page, the edit page) it renders nothing and the server
// resolves the name as before — refusing a homonym it cannot tell apart.

import { createContext, useContext } from "react";

export type RulePlace = { localityIndecId: string | null };

export const RulePlaceContext = createContext<RulePlace>({ localityIndecId: null });

export function RulePlaceField() {
  const { localityIndecId } = useContext(RulePlaceContext);
  if (!localityIndecId) return null;
  return <input type="hidden" name="jurisdictionLocalityIndecId" value={localityIndecId} />;
}
