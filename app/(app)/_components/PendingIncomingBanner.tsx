// "Esperan tu respuesta" — the banner on top of the owner's pages for what
// somebody else is waiting on: an invitation to look after their animal, or an
// offer of its titularidad. Data: `app/(app)/_lib/pending-incoming.ts`.
//
// EVERY ROW CARRIES WHAT IT TAKES TO DECIDE (decision-buttons-need-context):
// who asked, which animal and what kind of animal, the dates of the care or the
// day the offer lapses. Who asked is the display name /transferencias already
// shows — never an e-mail, nothing more.
//
// The link opens the existing screen where the answer is given. Nothing here
// accepts or rejects: that decision belongs on the page that shows the scope
// sentence and the confirmation step.
//
// Renders NOTHING when there is nothing pending or the read failed (`null`).
// An empty box on top of somebody's pets is furniture, and a failed read must
// never stand between them and the page.

import Link from "next/link";

import type { PendingIncoming, PendingIncomingItem } from "@/app/(app)/_lib/pending-incoming";
import { LnLinkButton } from "@/components/ui/LinkButton";
import { formatDateArOmitCurrentYear, pluralizeEs, speciesLabel } from "@/lib/utils/format";

/** Rows shown before the banner hands off to /transferencias. */
export const PENDING_INCOMING_MAX_ROWS = 3;

export function PendingIncomingBanner({
  pending,
  now = new Date(),
}: {
  pending: PendingIncoming | null;
  /** Injected so a test pins the "omit the current year" rule. */
  now?: Date;
}) {
  if (pending === null || pending.items.length === 0) return null;

  const { items } = pending;
  const shown = items.slice(0, PENDING_INCOMING_MAX_ROWS);
  const hidden = items.length - shown.length;

  return (
    <section
      aria-labelledby="pending-incoming-h"
      data-section="pending-incoming-banner"
      className="mb-5 rounded-[var(--radius-sm)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] px-4 py-3"
    >
      <h2
        id="pending-incoming-h"
        className="m-0 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-warn)]"
      >
        {items.length === 1
          ? "Esperan tu respuesta"
          : `Esperan tu respuesta · ${items.length} ${pluralizeEs(items.length, "pedido")}`}
      </h2>
      <ul className="m-0 mt-1 list-none divide-y divide-[var(--color-ln-warn-100)] p-0">
        {shown.map((item) => (
          <PendingRow key={`${item.kind}:${item.token}`} item={item} now={now} />
        ))}
      </ul>
      {hidden > 0 && (
        <Link
          href="/transferencias"
          className="mt-1 inline-block text-sm text-[var(--color-ln-azul)] underline-offset-2 hover:underline"
        >
          Ver {hidden} {pluralizeEs(hidden, "pedido")} más en Transferencias
        </Link>
      )}
    </section>
  );
}

function PendingRow({ item, now }: { item: PendingIncomingItem; now: Date }) {
  const pet = (
    <>
      <strong className="font-semibold">{item.petName}</strong> ({speciesLabel(item.petSpecies)})
    </>
  );
  const who = item.counterpartyName ? (
    <strong className="font-semibold">{item.counterpartyName}</strong>
  ) : null;

  return (
    <li
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5"
      data-pending-kind={item.kind}
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="m-0 font-ln-mono text-xs uppercase tracking-[.08em] text-[var(--color-ln-ink-2)]">
          {item.kind === "caretaker" ? "Cuidado temporal" : "Transferencia"}
        </p>
        <p className="m-0 mt-0.5 text-md text-[var(--color-ln-ink)]">
          {item.kind === "caretaker" ? (
            <>
              {who ? <>{who} te pidió</> : "Te pidieron"} que cuides a {pet} del{" "}
              {formatDateArOmitCurrentYear(item.startsAt, now)} al{" "}
              {formatDateArOmitCurrentYear(item.endsAt, now)}.
            </>
          ) : (
            <>
              {who ? <>{who} quiere transferirte</> : "Te quieren transferir"} a {pet}. Vence el{" "}
              {formatDateArOmitCurrentYear(item.expiresAt, now)}.
            </>
          )}
        </p>
      </div>
      <LnLinkButton href={item.href} shape="pill" fill="filled" className="flex-shrink-0">
        {item.kind === "caretaker" ? "Ver invitación" : "Ver transferencia"}
      </LnLinkButton>
    </li>
  );
}
