// Rule creation page. Driven by ?ruleType= querystring.
// Spec 2026-05-19-govt-business-rules-poc-design §6.3.

import Link from "next/link";

import { OpBreach, OpCrumbs } from "@/components/ui/dashboard";
import { GOVT_BUSINESS_RULE_TYPES, type GovtBusinessRuleType } from "@/db";
import { RULE_TYPE_REGISTRY } from "@/lib/domain/rule-types-registry";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { portalBase } from "@/lib/ui/portal-base";

import { RULE_FORM_REGISTRY, buildCreateFormExtraProps } from "./forms";

export const dynamic = "force-dynamic";

function decodeNullable(raw: string): string | null {
  if (raw === "_") return null;
  return decodeURIComponent(raw);
}

export default async function NewRulePage({
  params,
  searchParams,
}: {
  params: Promise<{ country: string; province: string; locality: string }>;
  searchParams: Promise<{ ruleType?: string }>;
}) {
  await requireAdminOrRedirect();
  const base = await portalBase();

  const { country: countryRaw, province: provinceRaw, locality: localityRaw } = await params;
  const sp = await searchParams;
  const country = decodeURIComponent(countryRaw);
  const province = decodeNullable(provinceRaw);
  const locality = decodeNullable(localityRaw);

  const ruleType = sp.ruleType as GovtBusinessRuleType | undefined;

  const backHref = `${base}/reglas/${encodeURIComponent(country)}/${encodeURIComponent(province ?? "_")}/${encodeURIComponent(locality ?? "_")}`;

  const RuleForm = ruleType ? RULE_FORM_REGISTRY[ruleType] : undefined;

  if (
    !ruleType ||
    !(GOVT_BUSINESS_RULE_TYPES as readonly string[]).includes(ruleType) ||
    !RuleForm
  ) {
    return (
      <div className="max-w-2xl space-y-4">
        <OpCrumbs items={[{ label: "Reglas", href: `${base}/reglas` }, { label: "Nueva regla" }]} />
        {/* Operator-facing, not developer-facing. This used to read "Falta
            ?ruleType= en la URL." — a query-string name shown to whoever
            lands here, which is an admin, not us. The page IS reachable with
            no rule type (by hand, or from a stale link), so the state is real;
            what it says about it was the problem. */}
        <OpBreach
          title={
            !ruleType || !(GOVT_BUSINESS_RULE_TYPES as readonly string[]).includes(ruleType)
              ? "No elegiste qué tipo de regla crear."
              : "Configuración de este tipo de regla no disponible aún."
          }
          detail="Volvé al listado de la jurisdicción y elegí el tipo desde ahí."
        />
        <Link
          href={backHref}
          className="text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
        >
          {/* "←", like the other 70 back links in the app. This was the one
              place still writing the ASCII arrow. */}
          {"← Volver"}
        </Link>
      </div>
    );
  }

  const jurisdictionLabel = `${country} · ${province ?? "(nivel país)"} · ${locality ?? "(toda la provincia)"}`;
  const extraProps = buildCreateFormExtraProps(ruleType, RULE_TYPE_REGISTRY[ruleType].default);

  return (
    <div className="max-w-2xl space-y-6">
      <OpCrumbs
        items={[
          { label: "Reglas", href: `${base}/reglas` },
          { label: jurisdictionLabel, href: backHref },
          { label: "Nueva regla" },
        ]}
      />

      <header className="space-y-1">
        <h1 className="text-title font-semibold text-ln-op-ink">Nueva regla</h1>
        <p className="text-md text-ln-op-ink-2">{jurisdictionLabel}</p>
      </header>

      <RuleForm
        mode="create"
        country={country}
        province={province}
        locality={locality}
        base={base}
        {...extraProps}
      />
    </div>
  );
}
