// /gob/reglas/[country]/[province]/[locality] — list + create entry points
// for the rule types of a specific jurisdiction (admin lens, design ADR-1).
// Spec 2026-05-19-govt-business-rules-poc-design §6.2.
//
// Route params: '_' is the sentinel for "null". So
// /gob/reglas/AR/_/_ -> country-level rules for AR.
//
// Addressed by id too (localidades-por-id D4): since migration 0263 two
// homonyms (Mechita, partido Alberti and partido Bragado) can each carry a
// rule under the same name. `?lugar=<catalogue row>` or `?unidad=<unit>`
// narrows the page to one place; the name alone, when it covers more than
// one place, lists them to choose from instead of mixing their rules.

import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";

import { OpCard, OpCardBody, OpCardHead, OpCrumbs } from "@/components/ui/dashboard";
import {
  GOVT_BUSINESS_RULE_TYPES,
  type GovtBusinessRuleType,
  db,
  govtBusinessRules,
  profiles,
} from "@/db";
import { jurisdictionLabel } from "@/lib/domain/jurisdiction-rules-href";
import {
  RULE_TYPE_REGISTRY,
  RULE_SOURCE_LABEL as SOURCE_LABEL,
  summarizeRulePayload,
} from "@/lib/domain/rule-types-registry";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import {
  type RulePlaceKey,
  loadRulePlaceLabels,
  rulePlaceQuery,
} from "@/lib/infra/rule-place-labels";
import { portalBase } from "@/lib/ui/portal-base";
import { formatDate } from "@/lib/utils/format";

import { DeleteRuleButton } from "./DeleteRuleButton";
import { RULE_FORM_REGISTRY } from "./nueva/forms";

export const dynamic = "force-dynamic";

function decodeNullable(raw: string): string | null {
  if (raw === "_") return null;
  return decodeURIComponent(raw);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function placeKeyFrom(sp: { lugar?: string; unidad?: string }): RulePlaceKey | null {
  if (sp.unidad && UUID_RE.test(sp.unidad)) return { kind: "unit", id: sp.unidad };
  if (sp.lugar && UUID_RE.test(sp.lugar)) return { kind: "locality", id: sp.lugar };
  return null;
}

export default async function JurisdictionReglasPage({
  params,
  searchParams,
}: {
  params: Promise<{ country: string; province: string; locality: string }>;
  searchParams?: Promise<{ lugar?: string; unidad?: string }>;
}) {
  await requireAdminOrRedirect();
  const base = await portalBase();

  const { country: countryRaw, province: provinceRaw, locality: localityRaw } = await params;
  const country = decodeURIComponent(countryRaw);
  const province = decodeNullable(provinceRaw);
  const locality = decodeNullable(localityRaw);
  const placeKey = placeKeyFrom((await searchParams) ?? {});

  const rows = await db
    .select({
      rule: govtBusinessRules,
      updatedBy: profiles.displayName,
    })
    .from(govtBusinessRules)
    .leftJoin(profiles, eq(profiles.id, govtBusinessRules.updatedByUserId))
    .where(
      and(
        eq(govtBusinessRules.jurisdictionCountry, country),
        province === null
          ? isNull(govtBusinessRules.jurisdictionProvince)
          : eq(govtBusinessRules.jurisdictionProvince, province),
        locality === null
          ? isNull(govtBusinessRules.jurisdictionLocality)
          : eq(govtBusinessRules.jurisdictionLocality, locality),
        placeKey
          ? placeKey.kind === "unit"
            ? eq(govtBusinessRules.authorityUnitId, placeKey.id)
            : eq(govtBusinessRules.localityId, placeKey.id)
          : undefined,
      ),
    );
  // The places this name covers among its rules: more than one, and no place
  // chosen, means homonyms — list them instead of mixing their rules.
  const labels = await loadRulePlaceLabels(rows.map((r) => r.rule));
  const places = placeKey ? [] : labels.distinctPlaces;
  if (places.length > 1) {
    return (
      <div className="space-y-6">
        <OpCrumbs
          items={[
            { label: "Reglas", href: `${base}/reglas` },
            { label: jurisdictionLabel(country, province, locality) },
          ]}
        />
        <header className="space-y-1">
          <h1 className="text-title font-semibold text-ln-op-ink">
            Reglas para {jurisdictionLabel(country, province, locality)}
          </h1>
          <p className="text-sm text-ln-op-mute">
            Hay más de un lugar con este nombre, y cada uno tiene sus propias reglas. Elegí cuál:
          </p>
        </header>
        <ul className="space-y-2">
          {places.map((p) => (
            <li key={`${p.key.kind}:${p.key.id}`}>
              <Link
                href={`?${rulePlaceQuery(p.key)}`}
                className="text-md font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
              >
                {p.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const placeLabel = placeKey ? labels.labelOf(placeKey) : null;

  const activeByType = new Map(rows.map((r) => [r.rule.ruleType, r]));
  // Exclude rule types that don't have a configuration form yet — no dead-end links.
  const missingTypes = GOVT_BUSINESS_RULE_TYPES.filter(
    (t) => !activeByType.has(t) && t in RULE_FORM_REGISTRY,
  );

  // E5 (2026-07-21 facades harvest) — cascade-mask indicator. A type absent
  // AT THIS EXACT LEVEL can still be governed by a country/province override
  // above it; this used to always show the hardcoded system default with no
  // way to tell. Resolve each missing type through the SAME cascade the govt
  // read-only lens uses (resolveBusinessRule), so "Default: X" only appears
  // when the value genuinely IS the hardcoded default — otherwise the real
  // source (and its resolved value) is shown instead.
  const missingResolved = await Promise.all(
    missingTypes.map((t) =>
      resolveBusinessRule(t, {
        country,
        province,
        locality,
        ...(placeKey?.kind === "locality" ? { localityId: placeKey.id } : {}),
      }).then((r) => ({ type: t, ...r })),
    ),
  );

  const segCountry = encodeURIComponent(country);
  const segProvince = encodeURIComponent(province ?? "_");
  const segLocality = encodeURIComponent(locality ?? "_");

  return (
    <div className="space-y-6">
      {/* Breadcrumbs */}
      <OpCrumbs
        items={[
          { label: "Reglas", href: `${base}/reglas` },
          { label: placeLabel ?? jurisdictionLabel(country, province, locality) },
        ]}
      />

      <header className="space-y-1">
        <h1 className="text-title font-semibold text-ln-op-ink">
          Reglas para {placeLabel ?? jurisdictionLabel(country, province, locality)}
        </h1>
      </header>

      {/* Active rules */}
      <section className="space-y-3">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          Reglas activas
        </p>
        {/* WHERE AM I (E5, 2026-07-21 facades harvest) — this list only shows
            rules configured EXACTLY at this jurisdiction level. A rule set
            at a more specific level below this one (e.g. a locality inside
            this province) can still take precedence for pets in that
            locality — see "Tipos sin excepción" below for the resolved
            (cascade-aware) picture of what's NOT overridden here. */}
        <p className="text-sm text-ln-op-mute">
          Configuradas exactamente en {jurisdictionLabel(country, province, locality)} — un nivel
          más específico (si existe) puede tener su propia excepción.
        </p>
        {rows.length === 0 && (
          <p className="text-md text-ln-op-mute">
            Esta jurisdicción no tiene excepciones. Toda regla cae a la cascada superior.
          </p>
        )}
        {rows.map(({ rule, updatedBy }) => (
          <OpCard key={rule.id}>
            <OpCardHead
              title={RULE_TYPE_REGISTRY[rule.ruleType as GovtBusinessRuleType].label}
              actions={
                <div className="flex gap-3">
                  <Link
                    href={`${base}/reglas/${segCountry}/${segProvince}/${segLocality}/editar/${rule.id}${placeKey ? `?${rulePlaceQuery(placeKey)}` : ""}`}
                    className="text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
                  >
                    Editar
                  </Link>
                  <DeleteRuleButton
                    ruleId={rule.id}
                    country={country}
                    province={province}
                    locality={locality}
                    base={base}
                  />
                </div>
              }
            />
            <OpCardBody>
              <p className="text-sm text-ln-op-mute mb-2">
                Actualizado {formatDate(rule.updatedAt)} {"·"} {updatedBy ?? "Sistema"}
              </p>
              <pre className="text-sm bg-ln-op-stripe rounded-[var(--radius-sm)] p-3 overflow-x-auto text-ln-op-ink-2">
                {JSON.stringify(rule.rulePayload, null, 2)}
              </pre>
              {rule.notes && <p className="text-sm text-ln-op-ink-2 mt-2">{rule.notes}</p>}
            </OpCardBody>
          </OpCard>
        ))}
      </section>

      {/* Missing types */}
      {missingTypes.length > 0 && (
        <section className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
            Tipos sin excepción en este nivel
          </p>
          <ul className="space-y-2">
            {missingResolved.map(({ type: t, payload, source }) => (
              <li key={t}>
                <OpCard>
                  <OpCardBody>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-md font-medium text-ln-op-ink">
                          {RULE_TYPE_REGISTRY[t].label}
                        </p>
                        <p className="text-sm text-ln-op-mute">
                          {RULE_TYPE_REGISTRY[t].description}
                        </p>
                        {/* Cascade-mask indicator (E5, 2026-07-21 facades
                            harvest) — resolved via the SAME cascade the govt
                            read-only lens uses, so a country/province
                            override above this level shows up honestly
                            instead of a blind "using the hardcoded default". */}
                        <p className="text-sm text-ln-op-mute mt-1">
                          <span
                            className={source === "default" ? "" : "font-medium text-ln-op-warn"}
                          >
                            {SOURCE_LABEL[source]}
                          </span>
                          {": "}
                          {summarizeRulePayload(t, payload)}
                        </p>
                      </div>
                      <Link
                        // A place chosen by id is configured from the wizard,
                        // which keys the rule on the row (a homonym's name
                        // alone would be refused).
                        href={
                          placeKey
                            ? `${base}/reglas/nueva`
                            : `${base}/reglas/${segCountry}/${segProvince}/${segLocality}/nueva?ruleType=${t}`
                        }
                        className="shrink-0 text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
                      >
                        {"Configurar →"}
                      </Link>
                    </div>
                  </OpCardBody>
                </OpCard>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
