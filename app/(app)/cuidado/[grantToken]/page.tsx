// `/cuidado/{grantToken}` — the caretaker invitation.
//
// THE ROUTE THE NOTIFICATION ALREADY POINTED AT. `designate-caretaker.ts` has
// been minting `/cuidado/${grant.publicToken}` as a notification ctaUrl since
// C7, and __tests__/link-integrity.test.ts has been failing on it ever since:
// "a button a real person can press that lands on a 404". This page is the
// destination; the notification was right, the route was missing.
//
// It sits under `(app)` for the citizen shell, so the URL stays `/cuidado/...`
// exactly as the invitation email and the Supabase invite redirect spell it.
//
// AUTH IS A SESSION CHECK, NOT A PET-ACCESS CHECK — and it could not be
// anything else. The invitee holds NO ownership row on this pet: that is what
// "invitation" means, and it is why requirePetAccess cannot resolve here. The
// authority is the unguessable grant token plus an id-or-email match, resolved
// inside the read model, exactly as the accept/reject actions re-check it
// server-side. This page can therefore never grant anything it displays.
//
// WHY AN OUTSIDER GETS A SENTENCE AND NOT A 404. The token travels by email and
// email gets forwarded — but far more often, the invitee IS the right person
// logged into the WRONG account (the invitation went to their personal address,
// the browser holds their work one). A 404 tells them the invitation does not
// exist; the truth is that it is not for THIS session. The read model already
// withholds the pet and the titular from a non-party, so saying so leaks
// nothing.

import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { LnCallout } from "@/components/ui/DocElements";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { petPhotoUrl } from "@/lib/infra/storage";
import { createClient } from "@/lib/supabase/server";
import { formatDateShort } from "@/lib/utils/format";
import { getGrantForViewer } from "@/src/modules/caretakers/application/get-grant-for-viewer";
import type { GrantStatus } from "@/src/modules/caretakers/domain/types";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";

import { CaretakerInvitationActions } from "./CaretakerInvitationActions";

// es-AR labels for the workflow states. Never render the raw enum value: it is
// snake_case machine vocabulary and lint:ui bans it in JSX text for good
// reason.
const STATUS_LABELS: Record<GrantStatus, string> = {
  pending: "Pendiente",
  accepted: "Activo",
  rejected: "Rechazada",
  cancelled: "Cancelada",
  expired: "Vencida",
  ended: "Terminado",
};

export default async function CaretakerGrantPage({
  params,
}: {
  params: Promise<{ grantToken: string }>;
}) {
  const { grantToken } = await params;
  const { user } = await requireUserOrRedirect(`/cuidado/${grantToken}`);

  // The email half of the id-or-email match. `profiles` has no email column —
  // it lives in auth.users — so it comes off the session, which is also the
  // only copy we are entitled to compare against.
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const viewerEmail = (authData?.user?.email ?? "").toLowerCase();
  // And whether anybody ever proved it (A09-1). Without this, "I signed up with
  // that address" reads as "I read that mailbox" on the one branch that decides
  // who may take write access to somebody else's animal.
  const viewerEmailConfirmed = authData?.user?.email_confirmed_at != null;

  const view = await getGrantForViewer(
    grantToken,
    { userId: user.id, email: viewerEmail, emailConfirmed: viewerEmailConfirmed },
    { repo: CaretakersRepository, now: () => new Date() },
  );

  // No such token. This one IS a 404: there is nothing to be wrong about.
  if (!view) notFound();

  if (view.relation === "outsider") {
    return (
      <div className="mx-auto max-w-md px-8 py-7 pb-12">
        <LnCallout tone="warn" title="Esta invitación no es para esta cuenta">
          Puede que la hayan enviado a otro correo tuyo. Cerrá sesión y volvé a entrar con la cuenta
          que recibió la invitación, o pedile a quien te invitó que la reenvíe a este correo.
        </LnCallout>
        <Link
          href="/mis-mascotas"
          className="mt-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          Ir a mis mascotas
        </Link>
      </div>
    );
  }

  const petName = view.pet?.name ?? "esta mascota";
  const titularName = view.titularName ?? "El titular";
  const photoSrc = petPhotoUrl(view.pet?.photoStoragePath);

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      <Link
        href="/mis-mascotas"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mis mascotas
      </Link>

      <div className="mb-6 flex items-start gap-4">
        {photoSrc && (
          <Image
            src={photoSrc}
            alt={petName}
            width={72}
            height={72}
            className="h-[72px] w-[72px] shrink-0 rounded-[var(--radius-sm)] object-cover"
          />
        )}
        <div className="min-w-0">
          <h1 className="m-0 font-ln-serif text-2xl font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-ink)]">
            {view.relation === "invitee"
              ? `Te invitaron a cuidar a ${petName}`
              : `Cuidado temporal de ${petName}`}
          </h1>
          <p className="mt-1 text-md text-[var(--color-ln-mute)]">
            {view.relation === "invitee"
              ? `${titularName} te propone cuidarla por un tiempo. No es una transferencia: sigue siendo su mascota.`
              : `Invitaste a ${titularName === "El titular" ? "alguien" : titularName} a cuidarla.`}
          </p>
        </div>
      </div>

      <LnCard className="mb-5">
        <LnCardHead title="Detalle del cuidado" />
        <LnCardBody>
          <dl className="flex flex-col gap-3">
            <DetailRow label="Estado">{STATUS_LABELS[view.status]}</DetailRow>
            <DetailRow label="Desde">{formatDateShort(view.startsAt)}</DetailRow>
            <DetailRow label="Hasta">{formatDateShort(view.endsAt)}</DetailRow>
            {view.note && <DetailRow label="Nota">{view.note}</DetailRow>}
          </dl>
        </LnCardBody>
      </LnCard>

      {view.canRespond && view.pet && (
        <CaretakerInvitationActions
          grantToken={view.grantPublicToken}
          petName={view.pet.name}
          titularName={titularName}
          scopeSentence={view.scopeSentence}
        />
      )}

      {/* Auto-end (or revocation) is never a silent disappearance: the pet has
          already left this person's /mis-mascotas by the time they open an old
          link, and this is the sentence that explains why. It says the ACCESS
          ended — never that the animal was handed back. */}
      {view.endedNotice && (
        <LnCallout tone="warn" title="El cuidado terminó">
          {view.endedNotice}
        </LnCallout>
      )}

      {view.relation === "invitee" && view.status === "accepted" && view.pet && (
        <LnCallout tone="azul" title={`Estás cuidando a ${petName}`}>
          Ya aparece en tus mascotas. Todo lo que anotes queda en su libreta.{" "}
          <Link href={`/mis-mascotas/${view.pet.publicToken}`}>Ver su libreta</Link>
        </LnCallout>
      )}

      {view.relation === "invitee" &&
        (view.status === "rejected" ||
          view.status === "cancelled" ||
          view.status === "expired") && (
          <LnCallout tone="azul" title="Esta invitación ya no está abierta">
            {view.status === "rejected" && "Rechazaste esta invitación."}
            {view.status === "cancelled" && `${titularName} retiró la invitación.`}
            {view.status === "expired" &&
              "Nadie respondió a tiempo y la invitación venció. Pedile a quien te invitó que la envíe de nuevo."}
          </LnCallout>
        )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 font-ln-mono text-xs uppercase tracking-[.08em] text-[var(--color-ln-mute)]">
        {label}
      </dt>
      <dd className="m-0 text-right text-md text-[var(--color-ln-ink)]">{children}</dd>
    </div>
  );
}
