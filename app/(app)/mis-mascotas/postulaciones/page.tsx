// Mis postulaciones para adoptar — Libreta Nacional redesign.
// Presentation only; all data fetching and status derivation logic unchanged.

import Link from "next/link";

import { LnCallout } from "@/components/ui/DocElements";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { formatDateShort } from "@/lib/utils/format";
import {
  type MyApplicationRow,
  type MyApplicationStatus,
  readMyAdoptionApplications,
} from "@/src/modules/adoption/infrastructure/my-applications-read";

import { WithdrawApplicationButton } from "./WithdrawApplicationButton";

// "Mis postulaciones" — applicant-side surface (spec adoption-listing-public
// §8.4 + D17). Lists the user's own `adoption_application_submitted` events,
// derives each application's status from later events.
//
// D17 enforced strictly: at no point do we expose how many other
// applications exist for the same pet, who else applied, or any queue
// position. The applicant only sees THEIR OWN row.
//
// THE QUERY LEFT THIS FILE (WU-U, 2026-08-30) and lives in
// `src/modules/adoption/infrastructure/my-applications-read.ts`, because
// `GET /api/v1/me/adoption-applications` now answers the same question to a
// bearer client. A second copy of that seven-branch status CASE would have been
// a second definition of what "aprobada" means. This page is presentation over
// the reader's rows; the art. 16 guard and the `stillListed` predicate moved
// with the SQL, and the module's header is where they are argued.

export const dynamic = "force-dynamic";

type ApplicationStatus = MyApplicationStatus;

type ApplicationRow = MyApplicationRow;

const STATUS_CONFIG: Record<ApplicationStatus, { label: string; cls: string }> = {
  pending: {
    label: "En revisión",
    cls: "border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]",
  },
  info_requested: {
    label: "Te pidieron info",
    cls: "border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul)]",
  },
  approved: {
    label: "Aprobada",
    cls: "border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)]",
  },
  finalized_to_me: {
    label: "¡Finalizada!",
    cls: "border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)]",
  },
  auto_rejected: {
    label: "Cerrada",
    cls: "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]",
  },
  rejected: {
    label: "No avanzó",
    cls: "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]",
  },
  withdrawn: {
    label: "Retirada",
    cls: "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]",
  },
};

export default async function MisPostulacionesPage({
  searchParams,
}: {
  searchParams: Promise<{ nueva?: string }>;
}) {
  const { user } = await requireUserOrRedirect();
  const params = await searchParams;
  const justSubmittedId = params.nueva ?? null;

  const applications = await readMyAdoptionApplications(user.id);

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
          Mis postulaciones para adoptar
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Acá ves el estado de tus postulaciones. El refugio te contacta por email cuando avanza.
        </p>
      </div>

      {justSubmittedId && (
        <div className="mb-5">
          <LnCallout tone="azul">
            ¡Postulación enviada! El refugio la recibió y te va a contactar por mail. Mientras tanto
            podés seguir viendo otras mascotas en{" "}
            <Link
              href="/adoptar"
              className="text-[var(--color-ln-azul)] no-underline hover:underline"
            >
              /adoptar
            </Link>
            .
          </LnCallout>
        </div>
      )}

      {applications.length === 0 ? (
        <LnEmptyState
          variant="dashed"
          title="Todavía no te postulaste para adoptar."
          description="Encontrá mascotas que buscan hogar y postulate con un click."
          action={
            <Link
              href="/adoptar"
              className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] px-4 py-2 font-ln-sans text-md font-medium text-[var(--color-ln-ok)] no-underline hover:opacity-80 transition-opacity"
            >
              Ver mascotas en adopción
            </Link>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
          {applications.map((app) => {
            const config = STATUS_CONFIG[app.status];
            const isHighlight = app.applicationId === justSubmittedId;
            return (
              <div
                key={app.applicationId}
                className={`flex flex-col gap-1.5 border-b border-[var(--color-ln-line-2)] px-4 py-3.5 last:border-b-0 ${isHighlight ? "bg-[var(--color-ln-celeste-050)]" : ""}`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-ln-serif text-md font-semibold text-[var(--color-ln-ink)]">
                    {app.petName}
                  </p>
                  <span
                    className={`flex-shrink-0 inline-flex items-center rounded-[var(--radius-xs)] border px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] ${config.cls}`}
                  >
                    {config.label}
                  </span>
                </div>
                <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
                  Refugio: {app.orgDisplayName}
                </p>
                <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
                  Enviada el {formatDateShort(app.submittedAt)}
                  {app.decisionAt && (
                    <>
                      {" · "}Última actualización: {formatDateShort(app.decisionAt)}
                    </>
                  )}
                </p>
                <StatusBody status={app.status} app={app} />
                {(app.status === "pending" || app.status === "info_requested") && (
                  <div className="mt-1">
                    <WithdrawApplicationButton applicationEventId={app.applicationId} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBody({ status, app }: { status: ApplicationStatus; app: ApplicationRow }) {
  if (status === "pending") {
    return (
      <p className="text-md text-[var(--color-ln-mute)]">
        El refugio está revisando tu postulación.
        {app.stillListed && (
          <>
            {" "}
            Mientras tanto podés ver la ficha de{" "}
            <Link
              href={`/adoptar/${app.petPublicToken}`}
              className="text-[var(--color-ln-azul)] no-underline hover:underline"
            >
              {app.petName}
            </Link>
            .
          </>
        )}
      </p>
    );
  }
  if (status === "info_requested") {
    return (
      <p className="text-md text-[var(--color-ln-azul)]">
        {app.orgDisplayName} te pidió más información sobre tu postulación. Revisá tus
        notificaciones y respondé por email para que puedan avanzar.
      </p>
    );
  }
  if (status === "withdrawn") {
    return (
      <p className="text-md text-[var(--color-ln-mute)]">
        Retiraste esta postulación.{" "}
        <Link href="/adoptar" className="text-[var(--color-ln-azul)] no-underline hover:underline">
          Ver otras en adopción
        </Link>
        .
      </p>
    );
  }
  if (status === "approved") {
    return (
      <p className="text-md text-[var(--color-ln-ok)]">
        El refugio aprobó tu postulación. Coordinan los próximos pasos por email.
      </p>
    );
  }
  if (status === "finalized_to_me") {
    return (
      <p className="text-md text-[var(--color-ln-ok)]">
        ¡Adoptaste a {app.petName}! Mirá su libreta digital en{" "}
        <Link
          href="/mis-mascotas"
          className="text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          Mis mascotas
        </Link>
        .
      </p>
    );
  }
  if (status === "auto_rejected") {
    return (
      <p className="text-md text-[var(--color-ln-mute)]">
        {app.petName} encontró hogar con otra postulación. Mirá{" "}
        <Link
          href={`/adoptar?org=${app.orgPublicToken}`}
          className="text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          otras mascotas de {app.orgDisplayName}
        </Link>{" "}
        o{" "}
        <Link href="/adoptar" className="text-[var(--color-ln-azul)] no-underline hover:underline">
          el listado completo
        </Link>
        .
      </p>
    );
  }
  return (
    <p className="text-md text-[var(--color-ln-mute)]">
      El refugio no avanzó con esta postulación.{" "}
      <Link href="/adoptar" className="text-[var(--color-ln-azul)] no-underline hover:underline">
        Ver otras en adopción
      </Link>
      .
    </p>
  );
}
