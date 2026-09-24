// AdminsScreen — the "Administradores" register of the Cuentas privilegiadas
// hub (privileged-accounts fusion, 2026-08-02, mirroring the F3 Directorio
// hub shape). This is the relocated body of the former standalone
// /admin/admins page (see ./page.tsx, now a permanent redirect into
// /admin/cuentas?registro=admins). The ONLY relocation changes are (a) the
// test-account toggle href now targets the hub route carrying
// `registro=admins`, and (b) the ScreenHeader renders under the hub. Every
// action is preserved: alta (+ Crear admin → /admin/admins/new), the
// per-account detail drill (/admin/admins/[userId], where grant/revoke and
// deactivation live), search, system/deactivated partitions. Guard
// unchanged: requireAdminOrRedirect.

import Link from "next/link";

import { eq } from "drizzle-orm";

import { LnEmptyState } from "@/components/ui/EmptyState";
import {
  OpCard,
  OpCardBody,
  OpFilterBar,
  OpPill,
  SearchFilterField,
} from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { db, profiles } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { isHiddenTestAccount } from "@/lib/infra/test-accounts";
import { buildAuthEmailMap, createAdminClient } from "@/lib/supabase/admin";
import { pluralizeEs } from "@/lib/utils/format";
import { normalizeText } from "@/lib/utils/text-normalize";

type AdminsSearchParams = { q?: string; test?: string };

export async function AdminsScreen({
  searchParams: sp,
  underHub = false,
}: {
  searchParams: AdminsSearchParams;
  underHub?: boolean;
}) {
  const { user } = await requireAdminOrRedirect();
  const query = (sp.q ?? "").trim();
  const showTestAccounts = sp.test === "1";

  const supabase = createAdminClient();

  const adminRows = await db
    .select({
      id: profiles.id,
      displayName: profiles.displayName,
      deactivatedAt: profiles.deactivatedAt,
      createdAt: profiles.createdAt,
      isSystem: profiles.isSystem,
    })
    .from(profiles)
    .where(eq(profiles.role, "admin"));

  // C21: page through ALL auth users so emails are complete past 200 operators.
  const emailMap = await buildAuthEmailMap(supabase);

  const allAdmins = adminRows.map((a) => ({
    ...a,
    email: emailMap.get(a.id) ?? "",
    isSelf: a.id === user.id,
  }));

  // R4 (opfilterbar-sweep-2026-07-21): the roster had NO filter at all — a
  // scroll-and-scan-only list, unlike every other roster screen
  // (/admin/govts, /gob|/admin usuarios). Accent-insensitive substring match
  // on name or email, in JS (this roster is bounded institutional operators,
  // not a paginated dataset — same cost class as the existing partition
  // filters below, no new query needed).
  const normalizedQuery = normalizeText(query);
  const admins = normalizedQuery
    ? allAdmins.filter(
        (a) =>
          normalizeText(a.displayName).includes(normalizedQuery) ||
          normalizeText(a.email).includes(normalizedQuery),
      )
    : allAdmins;

  // I3 (red-team-admin #18b): default the ephemeral genesis/smoke accounts OUT
  // of the roster — DB has ~69 of 76 admin profiles matching `uc-cd-*`/`*-gen-*`.
  // This console alone lacked the filter its sibling /admin/govts already ships;
  // mirror that pattern (UI-only filter — production carries no such rows). The
  // toggle below reveals them.
  //
  // NEVER filter out the person reading the page (cold-start review RA-6,
  // finding 4). `-gen-` is deliberately broad — lib/infra/test-accounts.ts names
  // it "genesis cold-start churn" — so the very first admin of a cold-start
  // deployment matches it. That admin then opened this console and was told
  // "No hay administradores activos", plus an instruction to go bootstrap one
  // in Supabase Studio, while logged in as one. A false positive is only
  // "fully recoverable via the toggle" if you are still visible enough to
  // believe the toggle is about somebody else.
  const hiddenTestCount = showTestAccounts ? 0 : admins.filter(isHiddenTestAccount).length;
  const visibleAdmins = showTestAccounts ? admins : admins.filter((a) => !isHiddenTestAccount(a));

  // Toggle for the test-account filter — preserves the active query. Targets
  // the HUB route carrying this register's tab (fusion 2026-08-02).
  const testToggleHref = (() => {
    const params = new URLSearchParams({ registro: "admins" });
    if (query) params.set("q", query);
    if (!showTestAccounts) params.set("test", "1");
    return `/admin/cuentas?${params.toString()}`;
  })();

  const activeAdmins = visibleAdmins.filter((a) => a.deactivatedAt === null);
  const deactivatedAdmins = visibleAdmins.filter((a) => a.deactivatedAt !== null);

  // C21/A7: keep service/system accounts out of the human admin list — they
  // aren't people and clutter the roster. Shown in a separate collapsed section
  // below. Partition by the DB flag (profiles.is_system), not a display-name
  // heuristic that broke once auth-user enumeration exceeded one page.
  const humanActive = activeAdmins.filter((a) => !a.isSystem);
  const systemActive = activeAdmins.filter((a) => a.isSystem);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <ScreenHeader
          underHub={underHub}
          title="Administradores"
          subtitle={
            <p className="text-sm text-ln-op-ink-2">
              Operadores institucionales con acceso de administrador.
            </p>
          }
        />
        <Link
          href="/admin/admins/new"
          className="px-4 py-2 text-sm font-semibold bg-ln-op-azul text-white rounded-[var(--radius-md)] hover:bg-ln-op-azul-700 shrink-0"
        >
          + Crear admin
        </Link>
      </div>

      {/* R4 fix — this roster had zero filters (PO: "admin no tiene ningún
          tipo de filtro posible"). Role is fixed (this list IS the admin
          role), so only a free-text search applies — no axis to register.
          SearchFilterField commits via serverNavCommit, preserving the hub's
          `registro` param. */}
      <OpFilterBar showPeriod={false}>
        <SearchFilterField
          paramKey="q"
          value={query}
          label="Buscar"
          placeholder="Buscar por nombre o email"
        />
      </OpFilterBar>

      {(hiddenTestCount > 0 || showTestAccounts) && (
        <Link
          href={testToggleHref}
          className="inline-block text-xs text-ln-op-mute underline underline-offset-4 hover:text-ln-op-ink-2"
        >
          {showTestAccounts
            ? "Ocultar cuentas de prueba"
            : `Mostrar ${hiddenTestCount} ${pluralizeEs(hiddenTestCount, "cuenta")} de prueba`}
        </Link>
      )}

      {humanActive.length === 0 ? (
        // Honest empty copy, mirroring the sibling /admin/govts roster: say
        // WHICH emptiness this is. The old single line claimed "No hay
        // administradores activos" and sent the reader to Supabase Studio —
        // told to an admin who is logged in, on a page with a "+ Crear admin"
        // button, that is false twice over (RA-6 finding 4).
        <LnEmptyState
          title={
            hiddenTestCount > 0
              ? "Solo hay cuentas de prueba en esta vista"
              : normalizedQuery
                ? "Sin resultados"
                : "No hay administradores humanos activos"
          }
          description={
            hiddenTestCount > 0
              ? undefined
              : normalizedQuery
                ? "Ajustá la búsqueda por nombre o email."
                : "Estás operando con una cuenta de sistema. Creá un administrador con «+ Crear admin»."
          }
          action={
            hiddenTestCount > 0 ? (
              <Link
                href={testToggleHref}
                className="text-sm underline underline-offset-4 text-ln-op-azul hover:text-ln-op-azul-700"
              >
                Mostrar {hiddenTestCount} {pluralizeEs(hiddenTestCount, "cuenta")} de prueba
              </Link>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {humanActive.map((a) => (
            <AdminRow key={a.id} admin={a} />
          ))}
        </ul>
      )}

      {systemActive.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm text-ln-op-mute hover:text-ln-op-ink-2 select-none">
            Cuentas de sistema ({systemActive.length})
          </summary>
          <p className="mt-1 text-sm text-ln-op-mute">
            Cuentas de servicio (backfills, jobs) — no son personas.
          </p>
          <ul className="mt-2 space-y-2">
            {systemActive.map((a) => (
              <AdminRow key={a.id} admin={a} />
            ))}
          </ul>
        </details>
      )}

      {deactivatedAdmins.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm text-ln-op-mute hover:text-ln-op-ink-2 select-none">
            Desactivados ({deactivatedAdmins.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {deactivatedAdmins.map((a) => (
              <AdminRow key={a.id} admin={a} />
            ))}
          </ul>
        </details>
      )}

      <p className="text-sm text-ln-op-mute">
        <Link href="/admin" className="underline underline-offset-4 hover:text-ln-op-ink-2">
          {"←"} Volver al panel
        </Link>
      </p>
    </div>
  );
}

type AdminRowProps = {
  admin: {
    id: string;
    displayName: string;
    email: string;
    isSelf: boolean;
    deactivatedAt: Date | null;
  };
};

function AdminRow({ admin }: AdminRowProps) {
  const isActive = admin.deactivatedAt === null;

  return (
    <li>
      <OpCard>
        <OpCardBody className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5 flex items-center gap-2">
            <div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/admin/admins/${admin.id}`}
                  className="text-md font-semibold text-ln-op-azul hover:underline underline-offset-4"
                >
                  {admin.displayName}
                </Link>
                {admin.isSelf && <OpPill tone="open">Vos</OpPill>}
              </div>
              <p className="text-sm text-ln-op-mute">{admin.email}</p>
            </div>
          </div>

          <OpPill tone={isActive ? "ok" : "neutral"}>{isActive ? "Activo" : "Desactivado"}</OpPill>
        </OpCardBody>
      </OpCard>
    </li>
  );
}
