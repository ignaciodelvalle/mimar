import { recordPostAdoptionCheckinAction } from "@/app/actions/checkin";
import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import {
  findOpenPostAdoptionCheckinReminder,
  isPetAdoptedByUser,
} from "@/lib/infra/adoption-checkin";
import { requirePetAccess } from "@/lib/infra/pet-access";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CheckinForm } from "./CheckinForm";

// Post-adoption check-in is the OWNER's self-report surface. Gated to:
//   (1) owner-path access (org-side members can READ the resulting event
//       via slice-7 cohabitation but must not WRITE the check-in);
//   (2) an adoption_finalized event exists for the pet AND the adopter
//       in the payload is the current user;
//   (3) at least one open post_adoption_checkin reminder is pending —
//       otherwise the page would let an over-eager adopter spam the
//       refugio with off-window check-ins.

export default async function PostAdoptionCheckinPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<{ notes?: string; autoconfirm?: string }>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;
  const access = await requirePetAccess(publicToken);
  if (!access.ok) {
    if (access.error === "Sesión expirada.") redirect("/iniciar-sesion");
    notFound();
  }
  // Check-in is owner-self only. Org-mediated access (refugios cohabiting
  // post-adoption) can READ the resulting event but not WRITE it.
  if (access.accessPath !== "owner") notFound();
  const { user, pet } = access;

  // Single source of truth with the anotar option assembly (QA A9): the same
  // predicate that decides whether the "Check-in post-adopción" entry renders
  // also gates this page — defense in depth for hand-typed URLs.
  if (!(await isPetAdoptedByUser(pet.id, user.id))) notFound();

  // THE SAME READ THE USE-CASE REFUSES ON. This page used to run its own copy
  // of the query; the writer now enforces "a window is open" as a rule for both
  // doors, so the page asks the one helper rather than keeping a second
  // definition of which row counts.
  const openReminder = await findOpenPostAdoptionCheckinReminder(pet.id, user.id);

  if (!openReminder) {
    return (
      <LnSheetWrap>
        <LnSheetCard>
          <div className="px-[18px] py-6 space-y-[10px]">
            <p className="font-ln-serif text-base font-semibold text-[var(--color-ln-ink)]">
              Sin check-ins pendientes
            </p>
            <p className="text-md text-[var(--color-ln-mute)]">
              {pet.name} no tiene un check-in post-adopción pendiente en este momento. Si el refugio
              te pide otro seguimiento más adelante, te vamos a avisar.
            </p>
            <Link
              href={`/mis-mascotas/${pet.publicToken}`}
              className="inline-block font-ln-mono text-sm text-[var(--color-ln-azul)] underline underline-offset-2"
            >
              ← Volver al perfil
            </Link>
          </div>
        </LnSheetCard>
      </LnSheetWrap>
    );
  }

  const boundAction = recordPostAdoptionCheckinAction.bind(null, pet.publicToken);

  return (
    <LnSheetWrap>
      <LnSheetCard>
        <CheckinForm
          action={boundAction}
          defaults={{ notes: sp.notes ?? null }}
          autoConfirm={sp.autoconfirm === "1"}
          windowDueLabel={openReminder.dueAt.toLocaleDateString("es-AR", {
            day: "numeric",
            month: "long",
            timeZone: "America/Argentina/Buenos_Aires",
          })}
        />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
