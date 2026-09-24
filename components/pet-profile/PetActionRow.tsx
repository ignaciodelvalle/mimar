// PetActionRow — labeled action bar for the pet profile, matching the "Una
// sola libreta" handoff's `.actionbar` (icon + short text, bordered,
// hover→azul; danger = seal red), in the handoff order:
//
//   Anotar · Compartir · Editar datos · Marcar como perdida (danger) · [spacer] · Más
//
// (PO 2026-07-05 — the earlier icon-only circle bar "read as mystery buttons".)
//
// Set by state/role:
//   - Anotar: owner, not deceased. 3b improvement C (2026-07-12) moved the
//     mid-face capture textarea out of the front to declutter it; this quiet
//     link is the pet-specific one-tap capture shortcut (opens ?sheet=anotar
//     for THIS pet) on every breakpoint, alongside the fixed "Asentar" bar in
//     CitizenTabBar (mobile, task #9). Owners may still write while lost — the
//     same owner+not-deceased gate the /anotar sheet uses.
//   - Compartir: always (owner + org read-only).
//   - Editar datos: owner, not deceased.
//   - Marcar como perdida (danger): owner, ACTIVE pet only. On a LOST pet the
//     "Marcar como encontrada" happy-path lives PROMINENTLY in LostCaseBlock
//     (not here, and never buried) — so this bar drops the lost/found slot.
//   - Más: owner (overflow — Chapita, transfer, emergencia, etc.).
//   - Deceased (ADR-15/REQ-9.3): collapses to [Compartir][Más].
//
// Each button opens its sheet via SheetTriggerLink — the History API directly
// (pushSheetUrl), NOT a Link/router.push soft navigation, to route around the
// Next.js 15.5.x App Router silent-drop defect (see lib/ui/sheet-nav.ts).

import { Icon } from "@/components/Icon";
import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";

type Props = {
  petPublicToken: string;
  isOwner: boolean;
  isDeceased: boolean;
  petStatus: "active" | "lost" | "deceased";
};

export function PetActionRow({ petPublicToken, isOwner, isDeceased, petStatus }: Props) {
  const href = (sheet: string) => `/mis-mascotas/${petPublicToken}?sheet=${sheet}`;

  return (
    <div data-section="action-row" className="ln-actionbar">
      {isOwner && !isDeceased && (
        <SheetTriggerLink href={href("anotar")} className="ln-act">
          <Icon name="libreta" size="sm" decorative />
          Anotar
        </SheetTriggerLink>
      )}

      <SheetTriggerLink href={href("compartir")} className="ln-act">
        <Icon name="share" size="sm" decorative />
        Compartir
      </SheetTriggerLink>

      {isOwner && !isDeceased && (
        <SheetTriggerLink href={href("editar-mascota")} className="ln-act">
          <Icon name="edit" size="sm" decorative />
          Editar datos
        </SheetTriggerLink>
      )}

      {isOwner && !isDeceased && petStatus === "active" && (
        <SheetTriggerLink href={href("marcar-perdida")} className="ln-act ln-act--danger">
          <Icon name="alert-triangle" size="sm" decorative />
          Marcar como perdida
        </SheetTriggerLink>
      )}

      {isOwner && (
        <>
          <span className="ln-act-spacer" aria-hidden />
          <SheetTriggerLink href={href("mas")} className="ln-act">
            <Icon name="ellipsis" size="sm" decorative />
            Más
          </SheetTriggerLink>
        </>
      )}
    </div>
  );
}
