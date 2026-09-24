// WorklistRow — one pending obligation in the /gob/acciones deadline
// worklist. Visual shape borrowed from WelfareDenunciaRow (the dominant
// operator-queue card anatomy): bordered card, subject + pills on the left,
// jurisdiction line, code badge, and a right-hand action column separated by
// a border.
//
// HONEST AFFORDANCES (the scout's finding, locked in here):
//   - denuncia: the ONE true inline mutation — TomarButton (reused from the
//     maltrato queue, same assignWelfareToMeAction) when unassigned, plus a
//     "Resolver →" link into the detail page that owns the motivo-gated
//     verbs. The inspector's ActuarButton is deliberately NOT reused: it
//     drives ?caso=/&panel= client state that only the Denuncias hub mounts.
//   - observación: "Cerrar →" link-out to the professional-closure flow.
//   - caso: "Ver →" link-out — no row mutation exists, none is invented.

import Link from "next/link";

import { OpCodeBadge, OpPill } from "@/components/ui/dashboard";
import { dueDateBadge } from "@/lib/domain/due-state";

import { TomarButton } from "@/app/gob/maltrato/_components/TomarButton";

import { WORKLIST_DOMAIN_LABEL, type WorklistItem } from "../_lib/worklist-core";

/** The link-out affordance — a real anchor (works without JS, opens in new
 *  tabs) styled like the queue's secondary action links. */
function ActionLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="whitespace-nowrap text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
    >
      {label} →
    </Link>
  );
}

export function WorklistRow({ item }: { item: WorklistItem }) {
  const badge = dueDateBadge(item.due);
  const isOverdue = item.due.state === "overdue";

  return (
    <li
      className={[
        "overflow-hidden rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card",
        // Overdue rows get the thick danger left edge — the same "read the
        // urgency before any text is parsed" treatment the maltrato queue
        // gives critical rows.
        isOverdue ? "border-l-4 border-l-ln-op-danger" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1 space-y-1 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-md font-medium text-ln-op-ink">
              {item.subject}
              {item.detail && (
                <span className="font-normal text-ln-op-mute">{` · ${item.detail}`}</span>
              )}
            </p>
            {/* The honest deadline badge: days to/past the deadline, computed
                from dueAt by lib/domain/due-state — never a tier number. */}
            <OpPill tone={badge.tone}>{badge.label}</OpPill>
          </div>
          <p className="text-xs text-ln-op-mute">
            {item.locality && item.province
              ? `${item.locality}, ${item.province}`
              : (item.province ?? "Sin jurisdicción declarada")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <OpPill tone="triaged">{WORKLIST_DOMAIN_LABEL[item.domain]}</OpPill>
            {item.code && <OpCodeBadge tone="blue">{item.code}</OpCodeBadge>}
          </div>
        </div>

        {/* Action column — sibling of the content, never nested in a link. */}
        <div className="flex shrink-0 flex-col items-end justify-center gap-1.5 border-l border-ln-op-line px-2.5 py-2">
          {item.action.type === "welfare" ? (
            <>
              {item.action.unassigned && <TomarButton reportId={item.action.reportId} />}
              <ActionLink href={item.action.href} label="Resolver" />
            </>
          ) : (
            <ActionLink href={item.action.href} label={item.action.label} />
          )}
        </div>
      </div>
    </li>
  );
}
