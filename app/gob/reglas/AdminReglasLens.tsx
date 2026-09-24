// AdminReglasLens — the admin capability lens of the unified /gob/reglas
// surface (design ADR-1).
//
// REDESIGN (2026-07-23, PO verdict): the previous IA opened with a grid of
// all 24 provincias (plus a per-province locality search box each — "muchísimas
// cajitas para buscar localidad") even though most jurisdictions carry no
// customization at all. That grid is gone. This screen now lists ONLY the
// jurisdictions that actually HAVE custom rules — each one a card naming
// which rule kinds it overrides, with a value summary and its provenance
// (país / provincia / localidad level). Creating a NEW rule goes through the
// step-by-step wizard at `${base}/reglas/nueva` (RulesWizard.tsx) instead of
// drilling through the old provincia→localidad grid; the deep per-jurisdiction
// detail route ([country]/[province]/[locality]/page.tsx) stays reachable
// from every card's "Ver detalle →" link (and from the wizard's own
// post-create redirect) — nothing that used to work stops working, only the
// ENTRY point simplified.
import Link from "next/link";

import { LnEmptyState } from "@/components/ui/EmptyState";
import {
  OpCard,
  OpCardBody,
  OpCardHead,
  OpCodeBadge,
  type OpFilterAxis,
  OpFilterBar,
} from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { GOVT_BUSINESS_RULE_TYPES, type GovtBusinessRuleType, db, govtBusinessRules } from "@/db";
import {
  buildJurisdictionRulesHref,
  jurisdictionLabel,
} from "@/lib/domain/jurisdiction-rules-href";
import {
  RULE_TYPE_REGISTRY,
  RULE_SOURCE_LABEL as SOURCE_LABEL,
  summarizeRulePayload,
} from "@/lib/domain/rule-types-registry";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { pluralizeEs } from "@/lib/utils/format";

type Props = {
  /**
   * Portal prefix the drill-down links must stay inside (portal-follows-viewer,
   * 2026-07-02) — this lens renders under both /admin/reglas and /gob/reglas.
   */
  base: "/admin" | "/gob";
  /**
   * Rule-kind filter (opfilterbar) — narrows the customized-jurisdictions
   * list to only cards that override this exact GovtBusinessRuleType. Empty
   * = show every customized jurisdiction. Unlike the old free-text search
   * (dropped — this list is short by construction, it only ever contains
   * jurisdictions that HAVE an override), a bounded kind dropdown is the
   * filter an admin actually reaches for here: "which jurisdictions touched
   * microchip_required?", not "find me a locality by name" (that job now
   * belongs to the wizard's own locality picker).
   */
  kind?: string;
};

type JurisdictionLevel = "country" | "province" | "locality";

type RuleOverride = {
  ruleType: GovtBusinessRuleType;
  label: string;
  summary: string;
};

type JurisdictionGroup = {
  key: string;
  country: string;
  province: string | null;
  locality: string | null;
  level: JurisdictionLevel;
  rules: RuleOverride[];
};

type RuleRow = {
  country: string;
  province: string | null;
  locality: string | null;
  ruleType: GovtBusinessRuleType;
  rulePayload: unknown;
};

/** Groups flat rule rows by their exact (country, province, locality) tuple —
 * one card per jurisdiction that has at least one override. Sort order: país
 * first, then provinces alphabetically, each province's own province-wide row
 * before its localities (also alphabetical) — a stable, scan-friendly order
 * with no artificial two-level tree UI. */
function buildJurisdictionGroups(rows: RuleRow[]): JurisdictionGroup[] {
  const map = new Map<string, JurisdictionGroup>();
  for (const row of rows) {
    const key = `${row.country}|${row.province ?? ""}|${row.locality ?? ""}`;
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        country: row.country,
        province: row.province,
        locality: row.locality,
        level: row.locality ? "locality" : row.province ? "province" : "country",
        rules: [],
      };
      map.set(key, group);
    }
    group.rules.push({
      ruleType: row.ruleType,
      label: RULE_TYPE_REGISTRY[row.ruleType].label,
      summary: summarizeRulePayload(row.ruleType, row.rulePayload),
    });
  }
  return Array.from(map.values()).sort((a, b) => {
    const provinceCompare = (a.province ?? "").localeCompare(b.province ?? "", "es");
    if (provinceCompare !== 0) return provinceCompare;
    return (a.locality ?? "").localeCompare(b.locality ?? "", "es");
  });
}

export async function AdminReglasLens({ base, kind = "" }: Props) {
  // Defense in depth (R1.9): the parent page already branches on
  // profile.role === "admin", but this component re-asserts the stricter
  // admin-only guard independently.
  await requireAdminOrRedirect();

  const rows = await db
    .select({
      country: govtBusinessRules.jurisdictionCountry,
      province: govtBusinessRules.jurisdictionProvince,
      locality: govtBusinessRules.jurisdictionLocality,
      ruleType: govtBusinessRules.ruleType,
      rulePayload: govtBusinessRules.rulePayload,
    })
    .from(govtBusinessRules)
    .orderBy(govtBusinessRules.jurisdictionProvince, govtBusinessRules.jurisdictionLocality);

  const groups = buildJurisdictionGroups(rows as RuleRow[]);

  const availableKinds = Array.from(new Set(groups.flatMap((g) => g.rules.map((r) => r.ruleType))));
  availableKinds.sort((a, b) =>
    RULE_TYPE_REGISTRY[a].label.localeCompare(RULE_TYPE_REGISTRY[b].label, "es"),
  );

  const normalizedKind = (GOVT_BUSINESS_RULE_TYPES as readonly string[]).includes(kind) ? kind : "";
  const visibleGroups = normalizedKind
    ? groups.filter((g) => g.rules.some((r) => r.ruleType === normalizedKind))
    : groups;

  const createHref = `${base}/reglas/nueva`;

  const kindAxis: OpFilterAxis = {
    id: "kind",
    label: "Tipo de regla",
    paramKey: "kind",
    current: normalizedKind || null,
    allLabel: "Todos",
    options: availableKinds.map((t) => ({ value: t, label: RULE_TYPE_REGISTRY[t].label })),
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ScreenHeader
          eyebrow="Admin · Reglas"
          title="Reglas por jurisdicción"
          subtitle={
            <p className="text-md text-ln-op-ink-2">
              {groups.length === 0
                ? "Ninguna jurisdicción tiene reglas personalizadas."
                : `${groups.length} ${pluralizeEs(groups.length, "jurisdicción", "jurisdicciones")} con reglas propias.`}
            </p>
          }
        />
        <Link
          href={createHref}
          className="shrink-0 rounded-[var(--radius-md)] bg-ln-op-azul px-3 py-1.5 text-md font-medium text-white no-underline transition-colors hover:bg-ln-op-azul-700"
        >
          {"+ Crear regla"}
        </Link>
      </div>

      {/* Defaults nacionales — compact disclosure (native <details>), so the
          baseline every jurisdiction's override is MEASURED AGAINST stays one
          click away without competing for attention with the actual content
          of this screen (the customized jurisdictions). */}
      <details className="group rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-md font-semibold text-ln-op-ink">
          <span>Defaults nacionales (referencia)</span>
          <span className="text-sm font-normal text-ln-op-mute">{"Ver →"}</span>
        </summary>
        <div className="space-y-3 border-t border-ln-op-line-2 px-4 py-3">
          <p className="text-sm text-ln-op-ink-2">
            Valores que rigen cuando ninguna jurisdicción los anula.
          </p>
          <ul className="divide-y divide-ln-op-line-2">
            {GOVT_BUSINESS_RULE_TYPES.map((t) => (
              <li key={t} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="text-md text-ln-op-ink">{RULE_TYPE_REGISTRY[t].label}</span>
                <span className="text-right text-sm text-ln-op-ink-2">
                  {summarizeRulePayload(t, RULE_TYPE_REGISTRY[t].default)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-ln-op-ink-2">
            ¿Necesitás una excepción a nivel país (sin ligar a ninguna provincia)?{" "}
            <Link
              href={buildJurisdictionRulesHref({ country: "AR", base })}
              className="font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
            >
              {"Configurala acá →"}
            </Link>
          </p>
        </div>
      </details>

      {groups.length === 0 ? (
        <LnEmptyState
          title="Ninguna jurisdicción tiene reglas personalizadas"
          description="Rigen los defaults nacionales en todo el país."
          action={
            <Link
              href={createHref}
              className="rounded-[var(--radius-md)] bg-ln-op-azul px-4 py-2 text-md font-medium text-white no-underline transition-colors hover:bg-ln-op-azul-700"
            >
              {"+ Crear regla"}
            </Link>
          }
        />
      ) : (
        <>
          {availableKinds.length > 1 && <OpFilterBar showPeriod={false} axes={[kindAxis]} />}

          {visibleGroups.length === 0 ? (
            <LnEmptyState
              title="Sin resultados para este filtro"
              description="Ninguna jurisdicción customiza este tipo de regla."
              // P2-2: this empty is caused by the operator's own `kind` filter,
              // so hiding it would read as "no rules exist anywhere" — the
              // misreading P2 must not create. It stays, with the MINIMUM: the
              // way back. The true-empty sibling branch above already carried
              // its own action ("+ Crear regla"); only this one was missed.
              action={
                <Link
                  href={`${base}/reglas`}
                  className="text-sm text-ln-op-azul no-underline underline-offset-4 hover:underline"
                >
                  Ver todos los tipos
                </Link>
              }
            />
          ) : (
            <ul className="space-y-3">
              {visibleGroups.map((group) => (
                <li key={group.key}>
                  <OpCard>
                    <OpCardHead
                      title={jurisdictionLabel(group.country, group.province, group.locality)}
                      actions={
                        <Link
                          href={buildJurisdictionRulesHref({
                            country: group.country,
                            province: group.province,
                            locality: group.locality,
                            base,
                          })}
                          className="text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
                        >
                          {"Ver detalle →"}
                        </Link>
                      }
                    />
                    <OpCardBody className="space-y-3">
                      <OpCodeBadge tone="neutral">{SOURCE_LABEL[group.level]}</OpCodeBadge>
                      <ul className="divide-y divide-ln-op-line-2">
                        {group.rules.map((rule) => (
                          <li
                            key={rule.ruleType}
                            className="flex items-baseline justify-between gap-3 py-1.5"
                          >
                            <span className="text-md font-medium text-ln-op-ink">{rule.label}</span>
                            <span className="text-right text-sm text-ln-op-ink-2">
                              {rule.summary}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </OpCardBody>
                  </OpCard>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
