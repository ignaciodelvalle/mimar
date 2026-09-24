// Atender mascota — walk-in clinical SIGNING surface (#43, B1).
//
// Resolves the pet by its DIM credential token with NO custody requirement
// (resolveAtenderPet). Authorization is event.write on this org + knowledge of
// the high-entropy DIM code (≈ physical possession of the credential). The
// surface exposes ONLY clinical event capture and ONLY pet identity — no owner
// PII (name/phone/DNI/address), no custody/transfer/adoption actions.
//
// The signed event carries the #43 provenance tier resolved by
// resolveAtenderPet: `verified_professional` when the signer holds a validated
// matrícula, else `org_registered`.

import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  OpCallout,
  OpCard,
  OpCardBody,
  OpCardHead,
  OpCodeBadge,
  OpCrumbs,
} from "@/components/ui/dashboard";
import { formatDateShort, speciesLabel } from "@/lib/utils/format";

import { CloseObservationForm } from "@/app/admin/observaciones/[publicToken]/CloseObservationForm";
import { formatObservationEnd } from "@/src/modules/surveillance/application/professional-close-observation";
import {
  isObservationOpen,
  resolveObservationDeadline,
  vetCloseRefusal,
} from "@/src/modules/surveillance/domain/rabies-observation";
import { SurveillanceRepository } from "@/src/modules/surveillance/infrastructure/surveillance-repository";
import {
  atenderCloseRabiesObservationAction,
  atenderRecordDeathInObservationAction,
} from "../actions";
import { resolveAtenderPet } from "../atender-access";
import { fetchPendingDeclaredEvents } from "../atender-declared-events";
import { AtenderCaptureMounter } from "./AtenderCaptureMounter";
import { AtenderQuickCapture } from "./AtenderQuickCapture";
import { PendingSignaturesCard } from "./PendingSignaturesCard";
import { RecordDeathInObservationForm } from "./RecordDeathInObservationForm";
import { ATENDER_EVENTOS, ATENDER_EVENTOS_CONDICIONALES } from "./atender-eventos";

/**
 * When this animal's open observation ends — the same deadline the close use
 * case holds a veterinarian's negative to, through the same fallback for
 * payloads written before `observation_until` existed. Null only in the
 * inconsistent state of an open status with no started event, which the server
 * refuses on its own.
 *
 * The deadline is not owner data: it is the bite date plus the window, about
 * the animal, and the credential's public page already shows the observation.
 */
async function loadObservationEnd(petId: string): Promise<Date | null> {
  const started = await new SurveillanceRepository().findLatestObservationStarted(petId);
  if (!started) return null;
  const payload = (started.payload ?? {}) as Record<string, unknown>;
  return resolveObservationDeadline(payload.observation_until, started.occurredAt);
}

export default async function AtenderSignPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgToken: string; publicToken: string }>;
  searchParams: Promise<{ evento?: string; firmado?: string; confirmEventId?: string }>;
}) {
  const { orgToken, publicToken } = await params;
  const sp = await searchParams;
  const access = await resolveAtenderPet(orgToken, publicToken);

  // See the sibling entry page: a shift that ran out has to SIGN THE OPERATOR
  // OUT, and only /turno-vencido can. Rendering the copy here would leave a live
  // session on the clinic's shared desk (B9).
  if (!access.ok && access.reason === "SHIFT_EXPIRED") redirect("/turno-vencido");

  if (!access.ok) {
    return (
      <main className="min-h-screen bg-ln-op-page p-6">
        <div className="max-w-lg mx-auto space-y-6">
          <OpCrumbs
            items={[
              { label: "Inicio", href: `/org/${orgToken}` },
              { label: "Atender mascota", href: `/org/${orgToken}/atender` },
              { label: "No encontrada" },
            ]}
          />
          <OpCard>
            <OpCardBody>
              <p className="text-md text-ln-op-ink-2">{access.error}</p>
              <div className="mt-4">
                <Link
                  href={`/org/${orgToken}/atender`}
                  className="text-sm text-ln-op-mute underline hover:text-ln-op-ink"
                >
                  ← Ingresar otro código
                </Link>
              </div>
            </OpCardBody>
          </OpCard>
        </div>
      </main>
    );
  }

  const { pet, signer } = access;
  // A confirmEventId means this visit is a PendingSignaturesCard confirmation,
  // not a grid pick — highlighting the grid tile then would invite a click on
  // a tile whose href drops confirmEventId, silently downgrading the
  // confirmation to a fresh placement (review of QA v3 M3 wiring).
  const activeEvento = sp.confirmEventId ? null : (sp.evento ?? null);

  // ¿Tiene este animal una observación antirrábica abierta? Decide si la pantalla
  // ofrece cerrarla. Mismo predicado que usa el caso de uso, importado y no
  // reescrito: una pantalla que ofreciera el cierre en un estado que el servidor
  // rechaza sería peor que no ofrecerlo.
  const observacionAbierta = isObservationOpen(access.pet.rabiesObservationStatus);
  // Y la matrícula, que es lo que separa poder ASENTAR de poder REGISTRAR UN
  // RESULTADO CLÍNICO. El servidor la exige igual; esto evita ofrecer un botón
  // que iba a rebotar.
  const puedeCerrarObservacion = observacionAbierta && access.signer.matriculaVerified;
  // The deadline, read only when the close card is actually on screen. Before
  // it, a veterinarian's negative is refused by the server (PO decision
  // 2026-09-18); the screen asks the same predicate so it never offers that
  // close as if it were available.
  const mostrarCierre = activeEvento === "observacion" && observacionAbierta;
  const finObservacion = mostrarCierre ? await loadObservationEnd(pet.id) : null;
  // PO D1 (2026-09-18): the same refusal the server applies, asked of each
  // outcome, so the form never offers what would bounce. "Sin seguimiento" is
  // refused at any time — the form withholds it even without a deadline.
  const ahora = new Date();
  const negativoBloqueadoHasta =
    finObservacion &&
    vetCloseRefusal("negative", finObservacion, ahora) === "negative_before_deadline"
      ? formatObservationEnd(finObservacion)
      : undefined;
  const fallecidoBloqueadoHasta =
    finObservacion && vetCloseRefusal("dead", finObservacion, ahora) === "dead_before_deadline"
      ? formatObservationEnd(finObservacion)
      : undefined;
  const justSigned = sp.firmado === "1";
  const pendingSignatures = await fetchPendingDeclaredEvents(pet.id);

  return (
    <main className="min-h-screen bg-ln-op-page p-6">
      <div className="max-w-lg mx-auto space-y-6">
        <header className="space-y-1">
          <OpCrumbs
            items={[
              { label: "Inicio", href: `/org/${orgToken}` },
              { label: "Atender mascota", href: `/org/${orgToken}/atender` },
              { label: pet.name },
            ]}
          />
          <h1 className="text-title font-semibold text-ln-op-ink">
            Atendiendo a {pet.name} · {speciesLabel(pet.species)}
          </h1>
          <p className="text-md text-ln-op-ink-2">
            Firmás como <strong>{signer.label}</strong>
            {signer.matriculaVerified ? " · verificado por profesional" : "."}
          </p>
          {!signer.matriculaVerified && (
            <p className="text-sm text-ln-op-mute">
              Queda registrado a nombre de la organización: es un registro válido, pero el sello
              “verificado por profesional” requiere un firmante con matrícula validada.
            </p>
          )}
          {/* REPORTED LOST — the whole reason this belongs here.
              `resolveAtenderPet` has always SELECTed pets.status and only ever
              branched on "deceased"; the lost state was fetched and thrown away
              (QA 2026-08-08 S3-F03). Meanwhile the person reading this screen is
              the best-placed human in the entire system to end the search: the
              animal is physically in front of them and somebody just carried it
              in. The North Star's second clause is "lost pets find their
              owners" — and this was the one screen where that could happen and
              nobody was told.
              The CTA is the existing anonymous finder flow, which already
              notifies the owner instantly with the finder's message and
              contact. Nothing new was built; a discarded field is now shown
              next to a door that was already open. */}
          {pet.status === "lost" && (
            /* Warn tokens rather than OpCallout: that primitive is navy/info,
               and its only other tone ("no-signal") is a MUTED warn for empty
               states. This is the shape DecomisoForm already uses for a
               consequential fact the operator must see before acting. */
            <div
              role="alert"
              className="rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-4 py-3 space-y-1"
            >
              <p className="text-md font-semibold text-ln-op-warn">
                Esta mascota está reportada como perdida
              </p>
              <p className="text-sm text-ln-op-warn">
                Su familia la está buscando. Si el animal está con vos, avisales ahora — les llega
                al instante.
              </p>
              <Link
                href={`/p/${pet.publicToken}/encontre`}
                className="inline-block text-sm font-semibold text-ln-op-warn underline"
              >
                Avisar que lo tenés →
              </Link>
            </div>
          )}
          <div className="pt-1">
            <OpCodeBadge tone="neutral">{pet.publicToken}</OpCodeBadge>
          </div>
        </header>

        {/* RA-2 F2: the receipt must state what actually happened. A signer
            without a validated matrícula produces an `org_registered` row —
            a valid record, NOT a signature — so telling them "firmado" is
            false for EVERY event type here, and next to a pending-signature
            card that (correctly) did not clear it reads as a broken write and
            invites the duplicate. Same flag the header above already uses. */}
        {justSigned && !activeEvento && (
          <output className="block rounded-[var(--radius-sm)] border border-ln-op-ok bg-ln-op-card px-3 py-2 text-sm text-ln-op-ink">
            {signer.matriculaVerified
              ? "Evento clínico firmado. Podés registrar otro o volver al inicio."
              : "Evento registrado a nombre de la organización. Quedó guardado, pero no lleva firma profesional: para eso lo tiene que registrar alguien con matrícula validada."}
          </output>
        )}

        <PendingSignaturesCard
          orgToken={orgToken}
          publicToken={pet.publicToken}
          pending={pendingSignatures}
          signerMatriculaVerified={signer.matriculaVerified}
        />

        <OpCard>
          {/* PO decision 4 (UI review 2026-08-06): "Contame qué pasó" is an
              intimate register that clashed with the notarial "Firmás como
              matrícula…" a few lines up — the walk-in is a professional
              record, not a confidence. The grid title below ("¿Qué querés
              registrar?") is unchanged. */}
          <OpCardHead title="Registrá lo que atendiste" />
          <OpCardBody>
            <AtenderQuickCapture orgToken={orgToken} publicToken={pet.publicToken} />
          </OpCardBody>
        </OpCard>

        <OpCard>
          <OpCardHead title="¿Qué querés registrar?" />
          <OpCardBody>
            <nav className="grid grid-cols-2 gap-2">
              {ATENDER_EVENTOS.filter(
                (e) => !ATENDER_EVENTOS_CONDICIONALES.has(e.key) || observacionAbierta,
              ).map((e) => {
                const isActive = activeEvento === e.key;
                return (
                  <Link
                    key={e.key}
                    href={`/org/${orgToken}/atender/${pet.publicToken}?evento=${e.key}`}
                    className={[
                      "block rounded-[var(--radius-sm)] border px-3 py-2 text-sm no-underline transition-colors",
                      isActive
                        ? "border-ln-op-azul bg-ln-op-stripe text-ln-op-ink"
                        : "border-ln-op-line bg-ln-op-card text-ln-op-ink hover:bg-ln-op-stripe",
                    ].join(" ")}
                  >
                    {e.label}
                  </Link>
                );
              })}
            </nav>
          </OpCardBody>
        </OpCard>

        {mostrarCierre && (
          <OpCard>
            <OpCardHead title="Cerrar observación antirrábica" />
            <OpCardBody>
              {/* The same callout, in the same words, as the State's close
                  screen (/admin/observaciones/[publicToken]). */}
              <OpCallout
                title="Observación activa"
                body={
                  finObservacion
                    ? `Cierre estimado: ${formatDateShort(finObservacion)}`
                    : "Sin fecha de cierre."
                }
              />
              {puedeCerrarObservacion ? (
                <>
                  {/* Qué significa este acto, antes del formulario. Termina una
                      obligación legal de la Ley 22.953 y da vuelta el cartel de
                      la credencial pública: no es asentar un evento más. */}
                  <p className="mb-4 text-sm text-ln-op-mute">
                    Registrás el resultado clínico de la observación de {access.pet.name}. Termina
                    el período legal y cambia lo que muestra su credencial pública. Queda asentado
                    con tu matrícula.
                  </p>
                  <CloseObservationForm
                    action={atenderCloseRabiesObservationAction.bind(
                      null,
                      orgToken,
                      access.pet.publicToken,
                    )}
                    negativeLockedUntil={negativoBloqueadoHasta}
                    deadLockedUntil={fallecidoBloqueadoHasta}
                    withholdLostToFollowup
                  />
                  {/* PO D8 (2026-09-18): a death DURING the observation is
                      recorded here, by the same licensed vet — the death,
                      the close and the urgent alert to the authority in one
                      act. Only while the window runs: after it, the close
                      above takes "Fallecido" on its own. */}
                  {access.pet.rabiesObservationStatus === "in_progress" && (
                    <div className="mt-6 border-t border-ln-op-line pt-4">
                      <RecordDeathInObservationForm
                        action={atenderRecordDeathInObservationAction.bind(
                          null,
                          orgToken,
                          access.pet.publicToken,
                        )}
                        petName={access.pet.name}
                      />
                    </div>
                  )}
                </>
              ) : (
                /* El motivo, no el silencio: un miembro sin matrícula validada
                   firma como organización y no como profesional, así que puede
                   asentar eventos y no puede registrar un resultado clínico. */
                <p className="text-sm text-ln-op-mute">
                  El resultado de una observación antirrábica lo registra un profesional con
                  matrícula validada. Si sos veterinario, pedí que se valide tu matrícula desde el
                  perfil de la organización.
                </p>
              )}
            </OpCardBody>
          </OpCard>
        )}

        <Suspense>
          <AtenderCaptureMounter
            orgToken={orgToken}
            publicToken={pet.publicToken}
            species={pet.species}
            signerVerified={access.signer.matriculaVerified}
          />
        </Suspense>

        <footer className="pt-2">
          <Link
            href={`/org/${orgToken}`}
            className="text-sm text-ln-op-mute underline hover:text-ln-op-ink"
          >
            ← Volver al inicio
          </Link>
        </footer>
      </div>
    </main>
  );
}
