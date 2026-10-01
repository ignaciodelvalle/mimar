// PetActionPanel — the owner's actions, grouped, below the primary row
// (owner-pet-actions, PO 2026-10-01).
//
//   LA MASCOTA   Editar datos · Foto · Contactos de emergencia · Perro de asistencia · Chapa física
//   SALUD        Recordatorios de vacunas
//   VIAJES       Viaje y movilidad
//   CUSTODIA     Cuidador temporal · Devolución · Acompañamiento de adopción · Transferir la titularidad
//   ─────────    Reportar fallecimiento
//
// What the "⋯ Más" sheet used to hide behind a tap is shown inline, under its
// theme, in the order the app shows it. The rows, their labels, the groups and
// who gets each row live or grey all come from the catalogue
// (`derivePetActions`); this file draws them and decides nothing.
//
// A GREY ROW IS SHOWN, NOT HIDDEN (PO: "lo que no aplica en gris con el
// motivo"): a co-owner reads "Transferir la titularidad — Solo el titular"
// before trying, instead of finding the boundary by pressing a button. It is
// text, not a disabled link: there is nothing to focus and nothing to press.
//
// THE CLOSING ACT HAS NO HEADING on purpose — the catalogue gives it `null`, so
// "Reportar fallecimiento" reads as the act it is, after everything else, and
// not as one more category.

import { Icon } from "@/components/Icon";

import { PetActionLink, petActionHintId } from "./PetActionLink";
import type { WebPetAction, WebPetActionGroup } from "./pet-action-web";

type Props = {
  /** The resolved groups (`resolveWebPetActions(...).groups`). */
  groups: readonly WebPetActionGroup[];
};

export function PetActionPanel({ groups }: Props) {
  if (groups.length === 0) return null;
  return (
    <nav
      aria-label="Acciones de la mascota"
      data-section="pet-action-panel"
      className="ln-actpanel"
    >
      {groups.map((group) =>
        group.heading ? (
          <section
            key={group.id}
            data-group={group.id}
            aria-labelledby={`pet-action-group-${group.id}`}
            className="ln-actgroup"
          >
            <h2 id={`pet-action-group-${group.id}`} className="ln-actgroup-h">
              {group.heading}
            </h2>
            <ActionList actions={group.actions} />
          </section>
        ) : (
          <div key={group.id} data-group={group.id} className="ln-actgroup ln-actgroup--closing">
            <ActionList actions={group.actions} />
          </div>
        ),
      )}
    </nav>
  );
}

function ActionList({ actions }: { actions: readonly WebPetAction[] }) {
  return (
    <ul className="ln-actlist">
      {actions.map((action) => (
        <li key={action.id}>
          <ActionLine action={action} />
        </li>
      ))}
    </ul>
  );
}

function ActionLine({ action }: { action: WebPetAction }) {
  const text = (
    <span className="ln-actline-text">
      <span className="ln-actline-label">{action.label}</span>
      {action.caption && <span className="ln-actline-caption">{action.caption}</span>}
    </span>
  );
  if (action.link === null) {
    return (
      <div className="ln-actline ln-actline--inert" aria-disabled="true">
        {text}
      </div>
    );
  }
  const hintId = petActionHintId(action.id);
  return (
    <>
      <PetActionLink link={action.link} className="ln-actline" describedBy={hintId}>
        {text}
        <Icon name="chevron-right" size="sm" decorative className="ln-actline-chev" />
      </PetActionLink>
      <span id={hintId} className="sr-only">
        {action.hint}
      </span>
    </>
  );
}
