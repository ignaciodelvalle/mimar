// Cuenta hub — Item 14.1 reorder.
//
// Layout: serif page title → identity card → verifications → grouped action
//   sections (Tu información / Rol y organizaciones / Privacidad y datos /
//   Zona de riesgo) → logout → footer → sheet mounter.
//
// Changes from previous flat "01 Acciones" list:
//   - Replaced single group with four named LnSectionHead groups.
//   - Dropped Notificaciones + Mis denuncias (already in OWNER_NAV — no duplicates).
//   - Added Zona de riesgo section visually separated (error border/bg) with
//     DeactivateAccountDialog (ConfirmDialog + motivo, ≥ 5 chars).
//   - Role/foster items appear per capabilities (owner, vet).

import Link from "next/link";
import { Suspense } from "react";

import { logoutAction } from "@/app/actions/auth";
import { db, organizationMemberships, profiles } from "@/db";
import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import {
  countActiveFosterOwnerships,
  countPendingFosterProposals,
} from "@/lib/analytics/owner-dashboard";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { avatarSignedUrl } from "@/lib/infra/storage";
import { shouldShowTagSurfaces } from "@/lib/infra/tag-surfaces-visibility";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { Icon } from "@/components/Icon";
import { LnBadge } from "@/components/ui/Badge";
import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { LnSectionHead } from "@/components/ui/DocElements";

import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";

import { CuentaSheetMounter } from "./CuentaSheetMounter";
import { DailyDigestCard } from "./_components/DailyDigestCard";
import { DeactivateAccountDialog } from "./_components/DeactivateAccountDialog";
import { PushNotificationsCard } from "./_components/PushNotificationsCard";
import { ReactivateAccountCard } from "./_components/ReactivateAccountCard";
import { RevokeSessionsDialog } from "./_components/RevokeSessionsDialog";

// Role display labels
const ROLE_LABELS: Record<string, string> = {
  owner: "Dueño/a",
  vet: "Veterinario/a",
  govt: "Gobierno",
  admin: "Administrador",
};

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  personal: "Personal",
  institutional: "Institucional",
};

// Deadline for the cuenta data load before it degrades to an honest error card
// instead of an unbounded "Cargando…" spin (task #50: /cuenta hang). A hung DB
// query no longer strands the user on the loading skeleton forever.
const CUENTA_LOAD_TIMEOUT_MS = 8_000;

/**
 * Load every row the cuenta hub needs. Profile read and pet count run in
 * parallel; the vet-clinic membership probe only runs for verified vets.
 *
 * Email comes from the session (`user.email`) — NOT a service-role
 * `auth.admin.getUserById` call. That admin lookup was an unbounded network
 * round-trip with no timeout: when the Supabase Auth admin API stalled, the
 * enclosing `Promise.all` never settled and the page hung on the loading
 * skeleton (task #50). `requireUserOrRedirect()` already carries the email for
 * exactly this display-only use, so the round-trip was redundant as well as
 * fragile (and it violated admin.ts's "only import from admin-institutional").
 */
async function loadCuentaData(userId: string) {
  const [rows, pendingProposals, activeFosters, showChapas] = await Promise.all([
    db
      .select({
        role: profiles.role,
        displayName: profiles.displayName,
        avatarStoragePath: profiles.avatarStoragePath,
        accountType: profiles.accountType,
        // Drives the reactivation card below, and it is the SAME column
        // requireLiveUser refuses writes on — so the page cannot show an
        // "activa" account that the write boundary is quietly refusing.
        deactivatedAt: profiles.deactivatedAt,
        // Wave 5 Item 25a: no plaintext DNI. Display uses dniLast4 only.
        dniLast4: profiles.dniLast4,
        dniVerified: profiles.dniVerified,
        matriculaNumber: profiles.matriculaNumber,
        matriculaJurisdiccion: profiles.matriculaJurisdiccion,
        matriculaVerified: profiles.matriculaVerified,
        preferredVetName: profiles.preferredVetName,
        preferredVetPhone: profiles.preferredVetPhone,
        emergencyContactName: profiles.emergencyContactName,
        emergencyContactPhone: profiles.emergencyContactPhone,
        phone: profiles.phone,
        dailyDigestOptOut: profiles.dailyDigestOptOut,
      })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1),
    // Foster badges (owner-ia-redesign P1 item 5) — the /cuenta/transitos hub
    // page that used to fetch these was removed; its 4 links folded into the
    // "Rol y organizaciones" group below, badges included.
    countPendingFosterProposals(userId).catch(() => 0),
    countActiveFosterOwnerships(userId).catch(() => 0),
    // Discovery-only jurisdiction gating (physical-tag design D6): the entry
    // hides when engraved_plate is disabled everywhere the user has pets AND
    // they hold no tags yet. /cuenta/chapas itself stays reachable by URL.
    shouldShowTagSurfaces(userId).catch(() => false),
  ]);

  const profile = rows[0];

  let vetNeedsClinic = false;
  if (profile?.role === "vet" && profile.matriculaVerified) {
    const [adminRow] = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          inArray(organizationMemberships.role, ["admin", "coordinator"]),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    vetNeedsClinic = !adminRow;
  }

  // The column holds a PATH into the private `avatars` bucket, not a URL, so
  // the renderable thing is minted here (migration 0219 / storage.ts
  // `avatarSignedUrl`). Deliberately INSIDE loadCuentaData so the Storage
  // round-trip is covered by the same `loadWithTimeout` bound as everything
  // else on this page — an unbounded signer is how /cuenta hung once already
  // (task #50). It fails to null, and null renders the initials monogram.
  const avatarUrl = await avatarSignedUrl(profile?.avatarStoragePath);

  return { profile, avatarUrl, vetNeedsClinic, pendingProposals, activeFosters, showChapas };
}

export default async function CuentaPage() {
  const { user } = await requireUserOrRedirect();

  // email is display-only (identity card) — taken straight from the session.
  const email = user.email ?? "";

  // Bound the whole load: a slow/hung query degrades to an error card with a
  // retry, never an unbounded spin on the loading skeleton (task #50).
  const load = await loadWithTimeout(loadCuentaData(user.id), CUENTA_LOAD_TIMEOUT_MS);

  if (!load.ok) {
    return (
      <div className="mx-auto max-w-4xl px-8 py-7">
        {/* The heading is static — it named the page before the load and still
            names it after the load failed. Dropping it left the fallback card
            floating with no indication of which page the user is even on. */}
        <h1 className="m-0 mb-7 font-ln-serif text-4xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Mi cuenta
        </h1>
        <LnCard>
          <LnCardHead title="No pudimos cargar tu cuenta" />
          <LnCardBody>
            <p className="text-md text-[var(--color-ln-ink-2)]">
              {load.reason === "timeout"
                ? "La carga está tardando más de lo esperado."
                : "Hubo un problema al cargar tus datos."}{" "}
              Volvé a intentar.
            </p>
            <Link
              href="/cuenta"
              className="mt-4 inline-flex items-center justify-center rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-4 py-[9px] text-md font-semibold text-[var(--color-ln-ink)] no-underline transition-colors hover:bg-[var(--color-ln-stripe)]"
            >
              Reintentar
            </Link>
          </LnCardBody>
        </LnCard>
      </div>
    );
  }

  const { profile, avatarUrl, vetNeedsClinic, pendingProposals, activeFosters, showChapas } =
    load.value;

  if (!profile) {
    return (
      <div className="mx-auto max-w-4xl px-8 py-7">
        <p className="text-md text-[var(--color-ln-err)]">
          No se encontró tu perfil. Cerrá sesión e intentá de nuevo.
        </p>
      </div>
    );
  }

  const initials = profile.displayName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  const roleLabel = ROLE_LABELS[profile.role] ?? profile.role;
  const accountTypeLabel = ACCOUNT_TYPE_LABELS[profile.accountType] ?? profile.accountType;

  const isPersonal = profile.accountType === "personal";
  // Since requireLiveUser reads `deactivated_at` for EVERY account type, this
  // is no longer a bookkeeping flag: it is the reason every write on this
  // account is being refused, and /cuenta is the surface that has to say so.
  const isDeactivated = profile.deactivatedAt != null;

  return (
    <div className="mx-auto max-w-4xl px-8 py-7 pb-12">
      {/* ------------------------------------------------------------------ */}
      {/* Page header                                                         */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-7">
        <h1 className="m-0 font-ln-serif text-4xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Mi cuenta
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Perfil, verificaciones y configuración.
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Deactivated state — ABOVE the identity card on purpose               */}
      {/* ------------------------------------------------------------------ */}
      {/* The person is here because the shell banner sent them, or because a
          write was refused. Putting the explanation and the way back under the
          fold, in the "Zona de riesgo" slot at the bottom, would make them scroll
          past every control that is currently inert to reach the only one that
          works. Personal accounts only: an institutional deactivation is an
          operator's act on somebody else's account, and its subject cannot undo
          it here (nor can they reach this page — the citizen layout routes an
          admin/govt role to its own portal). */}
      {isPersonal && isDeactivated && <ReactivateAccountCard />}

      {/* ------------------------------------------------------------------ */}
      {/* Identity card                                                        */}
      {/* ------------------------------------------------------------------ */}
      <LnCard className="mb-7">
        <LnCardHead title="Datos de la cuenta" />
        <LnCardBody>
          <div className="flex items-center gap-4">
            {/* Avatar */}
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={profile.displayName}
                className="h-[64px] w-[64px] flex-shrink-0 rounded-full border border-[var(--color-ln-line-strong)] object-cover"
              />
            ) : (
              <div className="flex h-[64px] w-[64px] flex-shrink-0 items-center justify-center rounded-full border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] font-ln-serif text-title font-semibold text-[var(--color-ln-ink-2)]">
                {initials}
              </div>
            )}

            <div className="min-w-0 flex-1">
              <p className="font-ln-serif text-lg font-semibold leading-tight text-[var(--color-ln-ink)]">
                {profile.displayName}
              </p>
              {email && (
                <p className="mt-0.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">{email}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <LnBadge variant="info">{roleLabel}</LnBadge>
                <LnBadge variant="neutral">{accountTypeLabel}</LnBadge>
                {/* Pet-count badge removed (owner-ia-redesign P5, decision 9):
                    the pet count is the /mis-mascotas index's own header now;
                    the account view slims to identity/role/rights for owners. */}
              </div>
            </div>
          </div>
        </LnCardBody>
      </LnCard>

      {/* ------------------------------------------------------------------ */}
      {/* Verifications                                                        */}
      {/* ------------------------------------------------------------------ */}
      <LnCard className="mb-7">
        <LnCardHead title="Verificaciones de identidad" />
        <LnCardBody>
          <div className="flex flex-col gap-3">
            {/* DNI — Wave 5 Item 25a: show last-4 only (no plaintext).
                Full DNI is never stored; disambiguation via dniLast4.

                THE AFFORDANCE BRANCHES ON THE SAME COLUMN THE SHEET DOES.
                This block used to branch on `dniLast4` while CuentaSheetMounter
                short-circuits on `dniVerified` (`if (dniVerified) return null`),
                so a profile with dniVerified=true and dniLast4=null rendered
                "Declarar ahora", changed the URL to ?sheet=verificar-dni, and
                opened nothing — a dead button, deterministically, forever. Every
                demo persona was in that state (master test CIU, hallazgo N2b).
                Whatever the columns say, the rule now holds structurally: the
                button renders if and only if the sheet will open.

                The same restructuring closes a second dead end nobody reported.
                `complete-identity.ts` writes dniLast4 WITHOUT dniVerified (the
                alta declares, it does not verify), and the old first branch
                rendered that state as "DNI ••••1234 no declarado" — digits on
                screen under a line denying they exist — with no way to finish.
                Now it says "sin verificar" and offers the step. */}
            {profile.dniVerified ? (
              <div className="flex items-center gap-2.5">
                <VerificationBadge verified />
                <span className="text-md text-[var(--color-ln-ink-2)]">
                  DNI{" "}
                  {profile.dniLast4 && (
                    <span className="font-ln-mono">{`••••${profile.dniLast4}`}</span>
                  )}{" "}
                  {/* DNI verification is self-declared (trust-on-input) until the Mi Argentina
                      integration lands. Use "declarado" to avoid overclaiming identity assurance. */}
                  declarado
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2.5">
                <span className="h-[8px] w-[8px] flex-shrink-0 rounded-full bg-[var(--color-ln-mute)]" />
                <span className="text-md text-[var(--color-ln-mute)]">
                  {profile.dniLast4 ? (
                    <>
                      DNI <span className="font-ln-mono">{`••••${profile.dniLast4}`}</span> sin
                      verificar
                    </>
                  ) : (
                    "DNI no declarado"
                  )}
                </span>
                <SheetTriggerLink
                  href="/cuenta?sheet=verificar-dni"
                  className="inline-flex items-center justify-center gap-[7px] rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-[11px] py-1.5 text-sm font-semibold text-[var(--color-ln-ink)] transition-colors hover:bg-[var(--color-ln-stripe)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)] no-underline"
                >
                  {profile.dniLast4 ? "Verificar ahora" : "Declarar ahora"}
                </SheetTriggerLink>
              </div>
            )}

            {/* Matrícula */}
            {profile.matriculaNumber ? (
              <div className="flex items-center gap-2.5">
                <VerificationBadge verified={profile.matriculaVerified} />
                <span className="text-md text-[var(--color-ln-ink-2)]">
                  Matrícula M.N. {profile.matriculaNumber}
                  {profile.matriculaJurisdiccion && ` (${profile.matriculaJurisdiccion})`}{" "}
                  {profile.matriculaVerified
                    ? "verificada"
                    : "— reportada al colegio / autoridad jurisdiccional — pendiente de validación"}
                </span>
              </div>
            ) : profile.role === "vet" ? (
              <div className="flex items-center gap-2.5">
                <span className="h-[8px] w-[8px] flex-shrink-0 rounded-full bg-[var(--color-ln-warn)]" />
                <span className="text-md text-[var(--color-ln-mute)]">Matrícula no cargada</span>
              </div>
            ) : null}
          </div>
        </LnCardBody>
      </LnCard>

      {/* ------------------------------------------------------------------ */}
      {/* Vet clinic banner                                                    */}
      {/* ------------------------------------------------------------------ */}
      {vetNeedsClinic && (
        <div className="mb-7 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-celeste-100)] border-t-[3px] border-t-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] px-[18px] py-3.5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-md font-semibold text-[var(--color-ln-ink)]">
                ¿Vas a ofrecer servicios profesionales?
              </p>
              <p className="mt-0.5 text-sm text-[var(--color-ln-ink-2)]">
                Creá tu consultorio para publicar servicios, gestionar turnos y emitir eventos en
                libretas sanitarias.
              </p>
            </div>
            <Link
              href="/cuenta/crear-consultorio"
              className="flex-shrink-0 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] px-3.5 py-2 font-ln-sans text-md font-semibold text-white no-underline hover:bg-[var(--color-ln-azul-700)]"
            >
              Crear consultorio →
            </Link>
          </div>
        </div>
      )}

      {/* ================================================================== */}
      {/* Grouped action sections (Item 14.1)                                 */}
      {/* ================================================================== */}

      {/* ------------------------------------------------------------------ */}
      {/* 01 Tu información                                                    */}
      {/* ------------------------------------------------------------------ */}
      <LnSectionHead num="01" title="Tu información" className="mb-4" />

      <div className="mb-8 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
        <ActionRow
          href="/cuenta?sheet=editar-perfil"
          opensSheet
          label="Editar mi información"
          description="Nombre, teléfono y foto de perfil"
        />
        {showChapas && (
          <ActionRow
            href="/cuenta/chapas"
            label="Mis chapas"
            description="Chapas físicas con QR vinculadas a tus mascotas"
          />
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 02 Rol y organizaciones                                              */}
      {/* Shown only for personal accounts. Institutional accounts (govt/     */}
      {/* admin) don't have org memberships or role transitions here.         */}
      {/* ------------------------------------------------------------------ */}
      {isPersonal && (
        <>
          <LnSectionHead num="02" title="Rol y organizaciones" className="mb-4" />

          <div className="mb-8 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
            {profile.role === "owner" && (
              <>
                {/* Two rows on purpose (Cowork QA parte A, 2026-08-06): the
                    single row promised BOTH paths but linked only the vet
                    sheet — org creation (/cuenta/upgrade, OrgCreateForm) was
                    fully built and unreachable from here. */}
                <ActionRow
                  href="/cuenta?sheet=solicitar-upgrade-vet"
                  opensSheet
                  label="Convertirme en profesional"
                  description="Registrá tu matrícula veterinaria y firmá eventos clínicos verificados"
                />
                <ActionRow
                  href="/cuenta/upgrade"
                  label="Crear una organización"
                  description="Clínicas, refugios y redes de rescate crean su panel organizacional"
                />
              </>
            )}
            {profile.role === "vet" && (
              <ActionRow
                href="/cuenta/crear-consultorio"
                label="Crear consultorio"
                description="Configurá tu consultorio veterinario para gestionar turnos y publicar servicios"
              />
            )}
            <ActionRow
              href="/cuenta/memberships"
              label="Mis organizaciones"
              description="Refugios, clínicas y redes en las que participás"
            />
            <ActionRow
              href="/cuenta/solicitudes"
              label="Mis solicitudes"
              description="Estado de tus solicitudes de rol"
            />
            {/* Tránsitos — folded in from the removed /cuenta/transitos hub
                page (owner-ia-redesign P1 item 5): its 4 links, badges
                included. */}
            <ActionRow
              href="/cuenta/ofrecerme-como-transito"
              label="Ofrecerme como hogar de tránsito"
              description="Inscribite en el pool de voluntarios para cuidar mascotas en custodia"
            />
            <ActionRow
              href="/cuenta/transitos/propuestas"
              label="Propuestas de tránsito"
              description="Refugios proponiéndote cuidar mascotas"
              badge={pendingProposals > 0 ? pendingProposals : undefined}
            />
            <ActionRow
              href="/cuenta/transitos/activos"
              label="Tránsitos activos"
              description="Mascotas que estás cuidando ahora"
              badge={activeFosters > 0 ? activeFosters : undefined}
            />
            <ActionRow
              href="/cuenta/transitos/historial"
              label="Historial de tránsitos"
              description="Tránsitos terminados y propuestas no concretadas"
            />
            {profile.role === "vet" && (
              <ActionRow
                href="/cuenta?sheet=renunciar-rol"
                opensSheet
                label="Renunciar a rol veterinario"
                description="Volvés a rol dueño/a"
                danger
              />
            )}
          </div>
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 03 Privacidad y datos                                                */}
      {/* ------------------------------------------------------------------ */}
      <LnSectionHead num={isPersonal ? "03" : "02"} title="Privacidad y datos" className="mb-4" />

      <div className="mb-8 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
        <ActionRow
          href="/cuenta/privacidad"
          label="Privacidad y derechos"
          description="Descargar tus datos · Eliminar cuenta · Ley 25.326"
        />
        {/* A04-1 — the in-account password change asks for the current
            password; the recovery page is for when it is lost. */}
        <ActionRow
          href="/cuenta/contrasena"
          label="Cambiar contraseña"
          description="Te pedimos la contraseña actual para confirmar que sos vos"
        />
        {/* B11 — the counterpart that makes B9's long citizen session
            defensible. It lives HERE, and not in "Zona de riesgo", because that
            section is for acts that destroy something irreversibly; this one is
            protective and its worst case is signing in again. Filing it under a
            red heading would teach people to hesitate over exactly the control
            they should reach for the moment a phone goes missing.
            Rendered for every account type — institutional operators lose a
            laptop as easily as anyone. */}
        <RevokeSessionsDialog />
      </div>

      {/* T2-N1 — daily operator digest opt-out. Rendered unconditionally, like
          PushNotificationsCard below: an account that never becomes a digest
          recipient just toggles a preference that never fires. */}
      <DailyDigestCard initialOptOut={profile.dailyDigestOptOut} />

      {/* Web Push v1 (feature-flagged): renders nothing unless
          NEXT_PUBLIC_PUSH_ENABLED + VAPID public key are configured. */}
      <PushNotificationsCard />

      {/* ------------------------------------------------------------------ */}
      {/* Zona de riesgo — personal accounts only. Visually separated:        */}
      {/* error-tone heading + border + bg. ConfirmDialog with mandatory       */}
      {/* motivo (≥ 5 chars) gates irreversible deactivation.                 */}
      {/* Govt deactivation lives at /cuenta/desactivar (coverage check).     */}
      {/* ------------------------------------------------------------------ */}
      {/* `!isDeactivated`: offering "Desactivar mi cuenta" to an account that is
          already deactivated is a control that can only refuse. The card at the
          top of the page is what stands in its place while the state holds. */}
      {isPersonal && !isDeactivated && (
        <section aria-labelledby="zona-riesgo-heading" className="mb-8">
          {/* Custom error-tone section heading — not using LnSectionHead      */}
          {/* because we need the error color variant.                          */}
          <div className="mb-4 flex items-baseline gap-3.5 border-b-2 border-[var(--color-ln-err)] pb-2.5">
            <span className="font-ln-mono text-sm font-semibold tracking-[.04em] text-[var(--color-ln-err)]">
              04
            </span>
            <h2
              id="zona-riesgo-heading"
              className="m-0 font-ln-serif text-title font-semibold tracking-[-0.01em] text-[var(--color-ln-err)]"
            >
              Zona de riesgo
            </h2>
          </div>
          <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-err)] bg-[var(--color-ln-err-050)]">
            <DeactivateAccountDialog />
          </div>
        </section>
      )}

      {/* Logout */}
      <form action={logoutAction} className="mt-1 mb-7">
        <button
          type="submit"
          className="rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-4 py-[9px] font-ln-sans text-md font-medium text-[var(--color-ln-err)] transition-colors hover:bg-[var(--color-ln-stripe)]"
        >
          Cerrar sesión
        </button>
      </form>

      {/* Footer */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[var(--color-ln-line-2)] pt-3.5 font-ln-mono text-sm uppercase tracking-[.04em] text-[var(--color-ln-faint)]">
        <span>Documento sincronizado</span>
        <span>miMAR · Registro Nacional de Mascotas</span>
      </div>

      {/* Sheet mounter */}
      <Suspense>
        <CuentaSheetMounter
          initialProfile={{
            displayName: profile.displayName ?? "",
            phone: profile.phone ?? "",
            avatarUrl: avatarUrl ?? "",
            preferredVetName: profile.preferredVetName ?? "",
            preferredVetPhone: profile.preferredVetPhone ?? "",
            emergencyContactName: profile.emergencyContactName ?? "",
            emergencyContactPhone: profile.emergencyContactPhone ?? "",
          }}
          role={profile.role}
          dniVerified={profile.dniVerified}
        />
      </Suspense>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function VerificationBadge({ verified }: { verified: boolean }) {
  if (verified) {
    return (
      <span
        aria-label="declarado"
        className="inline-flex h-[20px] w-[20px] flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)]"
      >
        <Icon name="check" size={13} decorative />
      </span>
    );
  }
  return (
    <span
      aria-label="no declarado"
      className="inline-flex h-[20px] w-[20px] flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]"
    >
      {/* clock/pending glyph */}
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    </span>
  );
}

function ActionRow({
  href,
  label,
  description,
  danger = false,
  badge,
  opensSheet = false,
}: {
  href: string;
  label: string;
  description: string;
  danger?: boolean;
  /** Pending-count pill (e.g. tránsitos propuestas/activos), folded in from the removed hub page. */
  badge?: number;
  /**
   * Same-route `?sheet=` target: render the History-API trigger instead of a
   * plain <Link>. A soft navigation to a sheet is exactly the hot path the App
   * Router 15.5 defect drops on the floor (lib/ui/sheet-nav.ts) — every row
   * that opened a sheet through <Link> here was dead on click.
   */
  opensSheet?: boolean;
}) {
  const Trigger = opensSheet ? SheetTriggerLink : Link;
  return (
    <Trigger
      href={href}
      className={[
        "flex items-center justify-between gap-4 border-b border-[var(--color-ln-line-2)] px-[18px] py-3.5 no-underline last:border-b-0",
        "hover:bg-[var(--color-ln-stripe)] transition-colors",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="min-w-0">
        <p
          className={`flex items-center gap-1.5 text-md font-medium leading-tight ${danger ? "text-[var(--color-ln-err)]" : "text-[var(--color-ln-ink)]"}`}
        >
          {danger && <Icon name="alerta" size={14} decorative />}
          {label}
        </p>
        <p className="mt-0.5 text-sm text-[var(--color-ln-mute)]">{description}</p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {badge !== undefined && (
          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--color-ln-azul)] px-1.5 font-ln-mono text-xs font-semibold text-white">
            {badge}
          </span>
        )}
        <span aria-hidden="true" className="text-base text-[var(--color-ln-mute)]">
          ›
        </span>
      </div>
    </Trigger>
  );
}
