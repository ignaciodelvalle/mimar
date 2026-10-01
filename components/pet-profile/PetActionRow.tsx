// PetActionRow — the primary row under the credential (owner-pet-actions,
// PO 2026-10-01): Anotar · Compartir · Modo perdida.
//
// WHAT IT SHOWS AND WHO GETS IT is the catalogue's (`derivePetActions`,
// `@dim/contract/reference`), the same one the app's panel renders from; WHERE
// each act leads is the web's (`pet-action-web.ts`). This component only draws:
// it holds no label, no order and no gate of its own, which is what let the old
// row, the "⋯ Más" sheet and the Anotar catalogue drift into three different
// answers.
//
// The row sits BELOW the credential now, not inside it (PO: "los botones salen
// de la tarjeta"), and keeps the handoff's `.actionbar` look — labeled buttons,
// 44px tall (`.ln-act` in globals.css), danger in seal red.

import { Icon } from "@/components/Icon";

import { PetActionLink, petActionHintId } from "./PetActionLink";
import type { WebPetAction } from "./pet-action-web";

type Props = {
  /** The resolved primary row (`resolveWebPetActions(...).primary`). */
  actions: readonly WebPetAction[];
};

export function PetActionRow({ actions }: Props) {
  if (actions.length === 0) return null;
  return (
    <div data-section="action-row" className="ln-actionbar">
      {actions.map((action) => (
        <PrimaryAct key={action.id} action={action} />
      ))}
    </div>
  );
}

function PrimaryAct({ action }: { action: WebPetAction }) {
  const content = (
    <>
      {action.icon && <Icon name={action.icon} size="sm" decorative />}
      {action.label}
    </>
  );
  if (action.link === null) {
    return (
      <span className="ln-act ln-act--inert" aria-disabled="true">
        {content}
        {action.caption && <span className="ln-act-caption">{action.caption}</span>}
      </span>
    );
  }
  const hintId = petActionHintId(action.id);
  return (
    <>
      <PetActionLink
        link={action.link}
        className={action.tone === "danger" ? "ln-act ln-act--danger" : "ln-act"}
        describedBy={hintId}
      >
        {content}
      </PetActionLink>
      <span id={hintId} className="sr-only">
        {action.hint}
      </span>
    </>
  );
}
