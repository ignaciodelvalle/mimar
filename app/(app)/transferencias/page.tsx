// Transferencias hub — Libreta Nacional redesign.
// UX 3.1: added outgoing (Enviadas) section alongside the existing received view.
//
// THE THREE QUERIES ARE GONE, and what replaced them is the point. They ran here
// inline, and the addressee predicate — "to_owner_id is me, OR the row is an open
// invitation to my e-mail" — was hand-written beside them as raw Drizzle. That
// predicate IS `validateRecipientMatch` (owner-transfer-rules.ts:124-134), the
// rule the accept and reject writers enforce, expressed a second time in a second
// language in a file that never imported it. Two copies of the rule that decides
// who may take somebody's animal.
//
// `listTransfersForUser` now owns both halves — the SQL predicate, once, in the
// repository, and the per-row capabilities, computed by calling the domain
// function itself. This page and `GET /api/v1/me/transfers` read the same lists
// through the same rule, which is what "parity by construction" has to mean for
// a feature whose whole security surface is one comparison.

import Link from "next/link";

import { LnSectionHead } from "@/components/ui/DocElements";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { formatDate, formatDateShort, speciesLabel } from "@/lib/utils/format";
import { listCaretakerGrantsForUser } from "@/src/modules/caretakers/application/list-caretaker-grants-for-user";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";
import { listTransfersForUser } from "@/src/modules/transfers/application/list-transfers-for-user";
import { TransfersRepository } from "@/src/modules/transfers/infrastructure/transfers-repository";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  accepted: "Aceptada",
  rejected: "Rechazada",
  expired: "Expirada",
  cancelled: "Cancelada",
};

export default async function TransferenciasHubPage() {
  const { supabase, user } = await requireUserOrRedirect();

  const { data: authData } = await supabase.auth.getUser();
  const callerEmail = (authData?.user?.email ?? "").toLowerCase();
  // An address nobody proved is not an addressee (A09-1): the list degrades to
  // the id predicate, so an open e-mail invitation and its token stay hidden.
  const callerEmailConfirmed = authData?.user?.email_confirmed_at != null;

  const { incoming, outgoing } = await listTransfersForUser(
    { userId: user.id, callerEmail, callerEmailConfirmed },
    { repo: TransfersRepository },
  );
  const activeRows = incoming.pending;
  const historyRows = incoming.history;
  const outgoingRows = outgoing;

  // T4-M4: an invitation to cuidar a un animal was previously reachable only
  // through the e-mail/notification link — nowhere in the app could an invitee
  // go LOOKING for it. `listCaretakerGrantsForUser` is the same read the
  // `/cuidado/{grantToken}` page and `GET /me/caretaker-grants` already use, so
  // this section shows nothing that was not already visible to this caller
  // through one of those two doors; it just gives the invitee a place to find it
  // without the original message. Only the INCOMING half is shown here — the
  // titular already sees every arrangement they granted on the pet's own page.
  const caretakerGrants = await listCaretakerGrantsForUser(
    { userId: user.id, callerEmail, callerEmailConfirmed },
    { repo: CaretakersRepository },
  );
  const caretakerInvitations = caretakerGrants.incoming.filter((g) => g.status === "pending");
  const activeCaretakerGrants = caretakerGrants.incoming.filter((g) => g.status === "accepted");

  return (
    <div className="mx-auto max-w-3xl px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href="/mis-mascotas"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mis mascotas
      </Link>

      {/* Header */}
      <div className="mb-7">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Transferencias
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Transferencias de mascotas recibidas y enviadas.
        </p>
      </div>

      <div className="flex flex-col gap-8">
        {/* ------------------------------------------------------------------ */}
        {/* RECIBIDAS                                                           */}
        {/* ------------------------------------------------------------------ */}
        <section aria-labelledby="recibidas-heading">
          <h2
            id="recibidas-heading"
            className="mb-4 font-ln-mono text-sm font-semibold uppercase tracking-[.08em] text-[var(--color-ln-ink-2)]"
          >
            Recibidas
          </h2>

          {/* Pending */}
          <div className="flex flex-col gap-5">
            <div>
              <LnSectionHead
                num="01"
                title="Pendientes"
                meta={activeRows.length > 0 ? `${activeRows.length}` : undefined}
                className="mb-4"
              />
              {activeRows.length === 0 ? (
                <p className="text-md text-[var(--color-ln-mute)]">
                  No tenés transferencias pendientes.
                </p>
              ) : (
                <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
                  {activeRows.map(
                    ({ transferToken, petName, petSpecies, counterpartyName, expiresAt }) => (
                      <Link
                        key={transferToken}
                        href={`/transferencias/${transferToken}`}
                        className="flex items-center justify-between gap-4 border-b border-[var(--color-ln-line-2)] px-4 py-3.5 no-underline last:border-b-0 hover:bg-[var(--color-ln-stripe)] transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="font-ln-serif text-base font-semibold text-[var(--color-ln-ink)]">
                            {petName}{" "}
                            <span className="font-ln-sans text-md font-normal text-[var(--color-ln-mute)]">
                              ({speciesLabel(petSpecies)})
                            </span>
                          </p>
                          {counterpartyName && (
                            <p className="mt-0.5 text-sm text-[var(--color-ln-mute)]">
                              De: {counterpartyName}
                            </p>
                          )}
                          <p className="mt-0.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">
                            Vence {formatDate(expiresAt)}
                          </p>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-2">
                          <span className="inline-flex items-center rounded-[var(--radius-xs)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-warn)]">
                            Pendiente
                          </span>
                          <span
                            aria-hidden="true"
                            className="text-base text-[var(--color-ln-mute)]"
                          >
                            ›
                          </span>
                        </div>
                      </Link>
                    ),
                  )}
                </div>
              )}
            </div>

            {/* History */}
            {historyRows.length > 0 && (
              <div>
                <LnSectionHead num="02" title="Historial" className="mb-4" />
                <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
                  {historyRows.map(({ transferToken, petName, counterpartyName, status }) => (
                    <Link
                      key={transferToken}
                      href={`/transferencias/${transferToken}`}
                      className="flex items-center justify-between gap-3 border-b border-[var(--color-ln-line-2)] px-4 py-3 no-underline last:border-b-0 hover:bg-[var(--color-ln-stripe)] transition-colors"
                    >
                      <p className="text-md text-[var(--color-ln-ink-2)]">
                        {petName}
                        {counterpartyName && (
                          <span className="text-[var(--color-ln-mute)]"> · {counterpartyName}</span>
                        )}
                        {" · "}
                        <span
                          className={
                            status === "accepted"
                              ? "text-[var(--color-ln-ok)]"
                              : "text-[var(--color-ln-mute)]"
                          }
                        >
                          {STATUS_LABELS[status] ?? status}
                        </span>
                      </p>
                      <span
                        aria-hidden="true"
                        className="flex-shrink-0 text-md text-[var(--color-ln-mute)]"
                      >
                        ›
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* CUIDADOS — invitaciones de cuidado temporal, lado del invitado      */}
        {/* ------------------------------------------------------------------ */}
        <section aria-labelledby="cuidados-heading">
          <h2
            id="cuidados-heading"
            className="mb-4 font-ln-mono text-sm font-semibold uppercase tracking-[.08em] text-[var(--color-ln-ink-2)]"
          >
            Cuidados
          </h2>

          <div className="flex flex-col gap-5">
            <div>
              <LnSectionHead
                num="03"
                title="Invitaciones a cuidar"
                meta={
                  caretakerInvitations.length > 0 ? `${caretakerInvitations.length}` : undefined
                }
                className="mb-4"
              />
              {caretakerInvitations.length === 0 ? (
                <p className="text-md text-[var(--color-ln-mute)]">
                  No tenés invitaciones a cuidar mascotas pendientes.
                </p>
              ) : (
                <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
                  {caretakerInvitations.map(
                    ({
                      grantToken,
                      petName,
                      petSpecies,
                      counterpartyName,
                      endsAt,
                      scopeSentence,
                    }) => (
                      <Link
                        key={grantToken}
                        href={`/cuidado/${grantToken}`}
                        className="flex items-center justify-between gap-4 border-b border-[var(--color-ln-line-2)] px-4 py-3.5 no-underline last:border-b-0 hover:bg-[var(--color-ln-stripe)] transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="font-ln-serif text-base font-semibold text-[var(--color-ln-ink)]">
                            {petName}{" "}
                            <span className="font-ln-sans text-md font-normal text-[var(--color-ln-mute)]">
                              ({speciesLabel(petSpecies)})
                            </span>
                          </p>
                          {counterpartyName && (
                            <p className="mt-0.5 text-sm text-[var(--color-ln-mute)]">
                              Te invitó: {counterpartyName}
                            </p>
                          )}
                          <p className="mt-0.5 text-sm text-[var(--color-ln-mute)]">
                            {scopeSentence}
                          </p>
                          <p className="mt-0.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">
                            Hasta {formatDate(endsAt)}
                          </p>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-2">
                          <span className="inline-flex items-center rounded-[var(--radius-xs)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-warn)]">
                            Pendiente
                          </span>
                          <span
                            aria-hidden="true"
                            className="text-base text-[var(--color-ln-mute)]"
                          >
                            ›
                          </span>
                        </div>
                      </Link>
                    ),
                  )}
                </div>
              )}
            </div>

            {/* Cuidados activos — only drawn when it has rows, same rule as
                Historial above: an empty heading over nothing is furniture. */}
            {activeCaretakerGrants.length > 0 && (
              <div>
                <LnSectionHead num="04" title="Cuidados activos" className="mb-4" />
                <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
                  {activeCaretakerGrants.map(
                    ({ grantToken, petName, counterpartyName, endsAt }) => (
                      <Link
                        key={grantToken}
                        href={`/cuidado/${grantToken}`}
                        className="flex items-center justify-between gap-3 border-b border-[var(--color-ln-line-2)] px-4 py-3 no-underline last:border-b-0 hover:bg-[var(--color-ln-stripe)] transition-colors"
                      >
                        <p className="text-md text-[var(--color-ln-ink-2)]">
                          {petName}
                          {counterpartyName && (
                            <span className="text-[var(--color-ln-mute)]">
                              {" "}
                              · {counterpartyName}
                            </span>
                          )}
                          <span className="text-[var(--color-ln-mute)]">
                            {" "}
                            · Hasta {formatDate(endsAt)}
                          </span>
                        </p>
                        <span
                          aria-hidden="true"
                          className="flex-shrink-0 text-md text-[var(--color-ln-mute)]"
                        >
                          ›
                        </span>
                      </Link>
                    ),
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* ENVIADAS                                                            */}
        {/* ------------------------------------------------------------------ */}
        <section aria-labelledby="enviadas-heading">
          <h2
            id="enviadas-heading"
            className="mb-4 font-ln-mono text-sm font-semibold uppercase tracking-[.08em] text-[var(--color-ln-ink-2)]"
          >
            Enviadas
          </h2>

          <LnSectionHead num="05" title="Mis transferencias enviadas" className="mb-4" />

          {outgoingRows.length === 0 ? (
            <p className="text-md text-[var(--color-ln-mute)]">
              No enviaste ninguna transferencia todavía.
            </p>
          ) : (
            <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
              {outgoingRows.map(
                ({ transferToken, petName, counterpartyName, toEmail, initiatedAt, status }) => (
                  <Link
                    key={transferToken}
                    href={`/transferencias/${transferToken}`}
                    className="flex items-center justify-between gap-3 border-b border-[var(--color-ln-line-2)] px-4 py-3 no-underline last:border-b-0 hover:bg-[var(--color-ln-stripe)] transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-md text-[var(--color-ln-ink-2)]">
                        {petName}
                        {(counterpartyName ?? toEmail) && (
                          <span className="text-[var(--color-ln-mute)]">
                            {" · "}
                            Para: {counterpartyName ?? toEmail}
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">
                        {formatDateShort(initiatedAt)}
                      </p>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <span
                        className={
                          status === "pending"
                            ? "inline-flex items-center rounded-[var(--radius-xs)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-warn)]"
                            : status === "accepted"
                              ? "inline-flex items-center rounded-[var(--radius-xs)] border border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-ok)]"
                              : "inline-flex items-center rounded-[var(--radius-xs)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]"
                        }
                      >
                        {STATUS_LABELS[status] ?? status}
                      </span>
                      <span aria-hidden="true" className="text-md text-[var(--color-ln-mute)]">
                        ›
                      </span>
                    </div>
                  </Link>
                ),
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
