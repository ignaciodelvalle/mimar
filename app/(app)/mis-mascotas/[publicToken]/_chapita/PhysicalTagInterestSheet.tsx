"use client";

// PhysicalTagInterestSheet — hosts the physical-tag-interest flow inside the
// pet profile's `?sheet=chapita` (pet-document-redesign ADR-17b, REQ-11.2).
//
// The physical-tag BACKEND survived the achievements/orphaned-UI cleanup
// intact — togglePhysicalTagInterestAction (write, owner-gated at the action
// layer) and getPhysicalTagInterest (read) were never deleted, only their
// standalone card (components/pet-profile/PhysicalTagInterestCard.tsx,
// removed by the two-face redesign). This is the same optimistic-UI logic,
// reshaped to render as a sheet body instead of a standalone card.

import { useState, useTransition } from "react";

import { togglePhysicalTagInterestAction } from "@/app/actions/physical-tag-interest";
import { Icon } from "@/components/Icon";
import type { PhysicalCredentialChannels } from "@/lib/domain/business-rules-defaults";
import { notifySaved } from "@/lib/ui/action-feedback";
import { AR_TIME_ZONE } from "@/lib/utils/format";

type Props = {
  petPublicToken: string;
  petName: string;
  initialInterested: boolean;
  initialRequestedAt: Date | null;
  /**
   * Physical credential channels available in the pet's jurisdiction
   * (admin-rules-console ADR-5/R3.5), resolved server-side. Null when the
   * caller couldn't resolve it (deceased pet, org viewer — never reaches
   * this component in that case).
   */
  channels: PhysicalCredentialChannels | null;
};

const DATE_FMT = new Intl.DateTimeFormat("es-AR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: AR_TIME_ZONE,
});

export function PhysicalTagInterestSheet({
  petPublicToken,
  petName,
  initialInterested,
  initialRequestedAt,
  channels,
}: Props) {
  const [interested, setInterested] = useState(initialInterested);
  const [requestedAt, setRequestedAt] = useState<Date | null>(initialRequestedAt);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onToggle() {
    setError(null);
    const optimisticNext = !interested;
    setInterested(optimisticNext);
    if (optimisticNext) {
      setRequestedAt((prev) => prev ?? new Date());
    }
    startTransition(async () => {
      const result = await togglePhysicalTagInterestAction(petPublicToken);
      if ("error" in result) {
        setInterested(!optimisticNext);
        setRequestedAt(initialRequestedAt);
        setError(result.error);
        return;
      }
      const nowInterested = result.state === "interested";
      setInterested(nowInterested);
      if (nowInterested && !requestedAt) {
        setRequestedAt(new Date());
      }
      // This sheet stays open — the toast is the confirmation
      // (mutation-feedback convention, lib/ui/action-feedback.ts).
      notifySaved(nowInterested ? "Interés anotado" : "Interés cancelado");
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2">
        <Icon name="tag" size="sm" decorative className="self-center text-[var(--color-ln-mute)]" />
        <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
          {interested ? "Chapa física — anotado" : `¿Querés una chapa física para ${petName}?`}
        </h2>
      </div>

      {/* "Te avisamos cuando estén disponibles" era una promesa sin mecanismo
          (auditoría 2026-08-04): nadie podía LEER la lista de anotados — el
          único lector era una consulta por mascota+usuario que responde "¿ya
          pediste vos?". Ahora la demanda se agrupa por localidad en
          /admin/programa, y como el aviso resultante es MANUAL, la copy dice
          eso y no promete un correo automático que no existe. */}
      {interested ? (
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Quedaste anotado. Te vamos a escribir cuando haya un canal disponible en tu zona.
          {requestedAt ? ` Anotado el ${DATE_FMT.format(requestedAt)}.` : null}
        </p>
      ) : (
        <>
          <p className="text-sm text-[var(--color-ln-ink-2)]">
            Una chapita con el QR de {petName} que cuelga del collar. Si alguien la encuentra,
            escanea y ve su libreta.
          </p>
          <p className="text-xs text-[var(--color-ln-mute)]">
            Estamos midiendo interés — no se cobra todavía.
          </p>
        </>
      )}

      <button
        type="button"
        onClick={onToggle}
        disabled={pending}
        className={
          interested
            ? "min-h-11 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] px-4 text-sm font-medium text-[var(--color-ln-ink-2)] transition-colors hover:bg-[var(--color-ln-stripe)] disabled:opacity-50"
            : "min-h-11 rounded-[var(--radius-sm)] bg-[var(--color-ln-azul)] px-4 text-sm font-medium text-white transition-colors hover:bg-ln-azul-700 disabled:opacity-50"
        }
      >
        {pending ? "Guardando…" : interested ? "Cancelar interés" : "Me interesa"}
      </button>

      {error && (
        <p className="text-xs text-[var(--color-ln-err)]" role="alert">
          {error}
        </p>
      )}

      {channels &&
        (channels.printable_qr || channels.engraved_plate.enabled || channels.nfc_tag.enabled) && (
          <div className="space-y-2 border-t border-[var(--color-ln-line)] pt-4">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-ln-mute)]">
              Canales disponibles en tu zona
            </p>
            {channels.printable_qr && (
              <p className="text-sm text-[var(--color-ln-ink-2)]">
                QR imprimible en casa —{" "}
                <a
                  href={`/mis-mascotas/${petPublicToken}/chapita`}
                  className="font-medium text-[var(--color-ln-azul)] underline underline-offset-2"
                >
                  imprimí la chapita de {petName}
                </a>{" "}
                y pegala en cualquier chapita física propia.
              </p>
            )}
            {channels.engraved_plate.enabled && (
              <p className="text-sm text-[var(--color-ln-ink-2)]">
                Placa grabada disponible
                {channels.engraved_plate.providerName
                  ? ` con ${channels.engraved_plate.providerName}`
                  : ""}
                {channels.engraved_plate.providerUrl && (
                  <>
                    {" — "}
                    <a
                      href={channels.engraved_plate.providerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-ln-azul)] underline underline-offset-2"
                    >
                      ver proveedor
                    </a>
                  </>
                )}
                .
              </p>
            )}
            {channels.nfc_tag.enabled && (
              <p className="text-sm text-[var(--color-ln-ink-2)]">
                Chapita NFC disponible
                {channels.nfc_tag.providerName ? ` con ${channels.nfc_tag.providerName}` : ""}
                {channels.nfc_tag.providerUrl && (
                  <>
                    {" — "}
                    <a
                      href={channels.nfc_tag.providerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-ln-azul)] underline underline-offset-2"
                    >
                      ver proveedor
                    </a>
                  </>
                )}
                .
              </p>
            )}
          </div>
        )}
    </div>
  );
}
