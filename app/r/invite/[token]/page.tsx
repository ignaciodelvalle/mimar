// Public invite acceptance page — renders correctly logged-out.
//
// Three session states:
//   1. No session → show invite details + link to login with returnTo.
//   2. Session but email doesn't match → inform user without leaking invite details.
//   3. Session + email matches → Accept button (calls acceptInvitationAction).
//
// Invalid/expired/revoked tokens render a friendly error, NOT notFound().
// Only the org display name and invited role are exposed — no other PII.
//
// Item 24.2: invalid-token states distinguish revoked / expired / used and
// include a CTA to the org's public contact page when the org is known.

import { eq } from "drizzle-orm";

import { db, organizationInvitations, organizations } from "@/db";
import { isPublicTokenReadThrottled } from "@/lib/infra/public-token-throttle";
import type { RateLimitConfig } from "@/lib/infra/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils/format";

import { AcceptButton } from "./AcceptButton";
import { maskEmail } from "./helpers";

// Per-IP ceiling for `invite_resolve` (audit A03-3). Until 2026-09-18 this page
// had none: one indexed read per attacker-supplied token, answering with four
// distinguishable states (not found / accepted / revoked / expired) and, for a
// live token, the org's name and the invited role.
//
// THE CALLER IS NOT THE CROWD /perdidas is sized for. An invitation is opened
// by the one person it was mailed to, and crawlers are kept out (robots.txt
// disallows /r/). The crowd case is an onboarding: a shelter sends its
// volunteers their invitations during a meeting and they open them in the same
// room, behind the same carrier gateway or office Wi-Fi. Opening one takes
// about three renders (the link, the bounce through login or signup, the
// return).
//
//   per minute   60 = twenty volunteers opening theirs in the same minute,
//                     three renders each
//   per hour    300 = that meeting five times over
//
// What it bounds: the state oracle, over an `INV-` space of 31^8 — at 300/hr
// one address needs ~2.8 × 10^9 hours to walk it — and the read behind it.
// Acceptance itself still needs a session whose e-mail matches the invitation,
// so the oracle never yielded a privilege; it yielded free reads. Fails open,
// like every caller of `isPublicTokenReadThrottled`.
const INVITE_RESOLVE_LIMIT: RateLimitConfig = { maxPerMinute: 60, maxPerHour: 300 };

function InviteThrottleNotice() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm space-y-4 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-8 text-center shadow-sm">
        <h1 className="font-ln-serif text-xl font-semibold text-[var(--color-ln-ink)]">
          Demasiadas consultas
        </h1>
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Recibimos muchas consultas desde tu conexión en poco tiempo. Esperá un minuto y volvé a
          abrir el link de la invitación.
        </p>
      </div>
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrador",
  coordinator: "Coordinador",
  member: "Miembro",
  volunteer: "Voluntario",
  vet_individual: "Veterinario",
  foster: "Tránsito",
};

export default async function InviteAcceptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Before the lookup, not after it: a limiter consulted after the read it is
  // meant to bound bounds nothing. Derivation above.
  if (await isPublicTokenReadThrottled("invite_resolve", INVITE_RESOLVE_LIMIT)) {
    return <InviteThrottleNotice />;
  }

  // Load invitation row — only the columns the page actually uses.
  // (organizations has sensitive fields like cuit/cbu; narrow the select so
  // only displayName + publicToken are fetched from that table.)
  // Item 24.2: publicToken added so invalid states can link to the org's
  // public contact page (/refugios/[orgToken]) instead of just the homepage.
  const [inviteRow] = await db
    .select({
      invite: {
        email: organizationInvitations.email,
        invitedRole: organizationInvitations.invitedRole,
        expiresAt: organizationInvitations.expiresAt,
        acceptedAt: organizationInvitations.acceptedAt,
        revokedAt: organizationInvitations.revokedAt,
        invitationToken: organizationInvitations.invitationToken,
      },
      org: {
        displayName: organizations.displayName,
        publicToken: organizations.publicToken,
      },
    })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .where(eq(organizationInvitations.invitationToken, token))
    .limit(1);

  // Determine validity before reading session (fast-fail path).
  const now = new Date();
  const isInvalid =
    !inviteRow ||
    !!inviteRow.invite.acceptedAt ||
    !!inviteRow.invite.revokedAt ||
    inviteRow.invite.expiresAt <= now;

  if (isInvalid) {
    // Item 24.2: distinguish each state with clear, specific messaging.
    const { heading, reason } = !inviteRow
      ? {
          heading: "Invitación no encontrada",
          reason: "Este link de invitación no existe o ya no es válido.",
        }
      : inviteRow.invite.acceptedAt
        ? {
            heading: "Invitación ya aceptada",
            reason: "Esta invitación ya fue aceptada anteriormente.",
          }
        : inviteRow.invite.revokedAt
          ? {
              heading: "Invitación revocada",
              reason: "Esta invitación fue revocada por la organización.",
            }
          : {
              heading: "Invitación vencida",
              reason: "Esta invitación ya expiró. Solicitá una nueva al equipo de la organización.",
            };

    // If we know the org, offer a direct link to their public contact page.
    const orgPublicToken = inviteRow?.org.publicToken ?? null;
    const orgDisplayName = inviteRow?.org.displayName ?? null;

    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 py-16">
        <div className="w-full max-w-sm space-y-4 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-8 text-center shadow-sm">
          {/* warning glyph — decorative, aria-hidden on both span and svg */}
          <span
            className="flex h-12 w-12 mx-auto items-center justify-center rounded-full bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]"
            aria-hidden="true"
          >
            <svg
              aria-hidden="true"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
          {/* a11y: h1 is the focus target; keyboard users Tab here first. */}
          <h1 className="font-ln-serif text-xl font-semibold text-[var(--color-ln-ink)]">
            {heading}
          </h1>
          <p className="text-sm text-[var(--color-ln-ink-2)]">{reason}</p>
          {/* Item 24.2: CTA to the org's public page when known, else homepage. */}
          {orgPublicToken ? (
            <>
              <a
                href={`/refugios/${orgPublicToken}`}
                className="inline-block rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] px-5 py-2 text-sm font-semibold text-white hover:bg-[var(--color-ln-azul-700)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)] focus-visible:ring-offset-2"
              >
                Contactar a {orgDisplayName}
              </a>
              <p className="text-xs text-[var(--color-ln-mute)]">
                Desde el perfil de la organización podés solicitar una nueva invitación.
              </p>
            </>
          ) : (
            <a
              href="/"
              className="inline-block rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] px-5 py-2 text-sm font-semibold text-white hover:bg-[var(--color-ln-azul-700)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)] focus-visible:ring-offset-2"
            >
              Ir al inicio
            </a>
          )}
        </div>
      </div>
    );
  }

  const { invite, org } = inviteRow;
  const roleLabel = ROLE_LABEL[invite.invitedRole] ?? invite.invitedRole;

  // Read Supabase session — always server-side.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const loginHref = `/iniciar-sesion?returnTo=${encodeURIComponent(`/r/invite/${token}`)}`;

  // State 1: no session.
  if (!user) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 py-16">
        <div className="w-full max-w-sm space-y-5 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-8 shadow-sm">
          <div className="space-y-1 text-center">
            <p className="text-xs uppercase tracking-widest text-[var(--color-ln-mute)]">
              Invitación
            </p>
            <h1 className="font-ln-serif text-title font-semibold text-[var(--color-ln-ink)]">
              {org.displayName}
            </h1>
          </div>
          <p className="text-sm text-[var(--color-ln-ink-2)] text-center">
            Te invitaron a sumarte como <strong>{roleLabel}</strong>. Iniciá sesión o creá una
            cuenta para aceptar.
          </p>
          <a
            href={loginHref}
            className="block w-full rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] px-5 py-2.5 text-center text-sm font-semibold text-white hover:bg-[var(--color-ln-azul-700)] transition-colors"
          >
            Iniciar sesión
          </a>
          <a
            href={`/registro?returnTo=${encodeURIComponent(`/r/invite/${token}`)}`}
            className="block w-full rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] px-5 py-2.5 text-center text-sm font-semibold text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)] transition-colors"
          >
            Crear cuenta
          </a>
          <p className="text-center text-xs text-[var(--color-ln-mute)]">
            Este link vence el {formatDate(invite.expiresAt)}.
          </p>
        </div>
      </div>
    );
  }

  const sessionEmail = user.email?.toLowerCase().trim() ?? "";

  // State 2: email mismatch — show masked address only (PII: do not expose the
  // full invite email to whoever holds the token).
  if (invite.email.toLowerCase() !== sessionEmail) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 py-16">
        <div className="w-full max-w-sm space-y-4 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-8 text-center shadow-sm">
          {/* lock glyph */}
          <span
            className="flex h-12 w-12 mx-auto items-center justify-center rounded-full bg-[var(--color-ln-stripe)] text-[var(--color-ln-ink-2)]"
            aria-hidden="true"
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </span>
          <h1 className="font-ln-serif text-xl font-semibold text-[var(--color-ln-ink)]">
            Cuenta incorrecta
          </h1>
          <p className="text-sm text-[var(--color-ln-ink-2)]">
            Esta invitación es para{" "}
            <strong className="font-semibold">{maskEmail(invite.email)}</strong>. Iniciá sesión con
            esa cuenta para aceptarla.
          </p>
          <a
            href={loginHref}
            className="inline-block rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] px-5 py-2 text-sm font-semibold text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)] transition-colors"
          >
            Cambiar cuenta
          </a>
        </div>
      </div>
    );
  }

  // State 3: session + email matches → show accept button.
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm space-y-5 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-8 shadow-sm">
        <div className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-widest text-[var(--color-ln-mute)]">
            Invitación
          </p>
          <h1 className="font-ln-serif text-title font-semibold text-[var(--color-ln-ink)]">
            {org.displayName}
          </h1>
        </div>
        <p className="text-sm text-[var(--color-ln-ink-2)] text-center">
          Fuiste invitado a sumarte como <strong>{roleLabel}</strong>. ¿Querés aceptar y unirte al
          equipo?
        </p>
        <AcceptButton invitationToken={token} />
        <div className="text-center">
          <a
            href="/"
            className="text-xs text-[var(--color-ln-mute)] underline underline-offset-2 hover:text-[var(--color-ln-ink)] transition-colors"
          >
            Más tarde
          </a>
        </div>
      </div>
    </div>
  );
}
