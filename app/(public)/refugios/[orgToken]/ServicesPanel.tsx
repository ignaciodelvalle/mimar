import Link from "next/link";

import { Icon } from "@/components/Icon";
import { LnBadge } from "@/components/ui/Badge";
import { LnCard, LnCardBody } from "@/components/ui/Card";
import { LnSectionHead } from "@/components/ui/DocElements";
import type { PublicServiceOffering } from "@/lib/infra/org-public-offerings";
import { AR_TIME_ZONE } from "@/lib/utils/format";

// "Servicios" panel (handoff P2-5) — Libreta Nacional look.
//
// Render-or-don't-render: when the offerings list is empty, the panel
// doesn't render at all. The org owner explicitly opts each offering
// into the public surface via service_offerings.is_public (P1-3); the
// privacy-first default keeps surfaces clean by default.
//
// Each row:
//   [icon 24px] Title
//                Short description (one line)
//                [chips: Gratuito / Sin turno / Próximo / Sin agenda]
//                                                        Reservar →
//
// Click:
//   - requiresAppointment → /turnos/buscar/{token}
//   - otherwise → ?sheet=consulta-sin-turno (P2-9 sheet)
//
// Badge API note: poncho Badge (variant-based display pill) is kept here
// because LnChip is an interactive toggle button — APIs are not
// compatible for static display use. Token-swap handled by wrapper classes.

const KIND_ICON: Record<string, string> = {
  sterilization: "esterilizacion",
  vaccine: "vacuna",
  microchip: "microchip",
  consultation: "vet",
  other: "huella",
};

function kindIcon(kind: string): string {
  return KIND_ICON[kind] ?? KIND_ICON.other;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "short",
    timeZone: AR_TIME_ZONE,
  });
}

interface Props {
  orgToken: string;
  offerings: PublicServiceOffering[];
}

const MAX_VISIBLE = 8;

export function ServicesPanel({ orgToken, offerings }: Props) {
  if (offerings.length === 0) return null;

  const visible = offerings.slice(0, MAX_VISIBLE);
  const hasMore = offerings.length > MAX_VISIBLE;

  return (
    <section aria-label="Servicios">
      <LnSectionHead
        title="Servicios"
        meta={
          hasMore ? (
            <Link
              href={`/turnos/buscar?org=${orgToken}`}
              className="font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] hover:underline focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]"
            >
              Ver todos →
            </Link>
          ) : undefined
        }
        className="mb-4"
      />
      <LnCard>
        <LnCardBody className="px-0 py-0">
          <ul className="divide-y divide-[var(--color-ln-line-2)]">
            {visible.map((offering) => {
              const href = offering.requiresAppointment
                ? `/turnos/buscar/${offering.offeringToken}`
                : `?sheet=consulta-sin-turno&offering=${offering.offeringToken}`;
              return (
                <li key={offering.offeringToken}>
                  <Link
                    href={href}
                    className="flex items-start gap-3 py-3 px-4 transition-colors hover:bg-[var(--color-ln-stripe)] focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)] focus-visible:ring-inset"
                  >
                    <span aria-hidden className="shrink-0 mt-0.5 text-[var(--color-ln-azul)]">
                      <Icon name={kindIcon(offering.serviceKind)} size="lg" decorative />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm font-medium text-[var(--color-ln-ink)]">
                        {offering.title}
                      </p>
                      {offering.description && (
                        <p className="text-xs text-[var(--color-ln-mute)] line-clamp-1">
                          {offering.description}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {offering.free && <LnBadge variant="success">Gratuito</LnBadge>}
                        {!offering.requiresAppointment && (
                          <LnBadge variant="neutral">Sin turno</LnBadge>
                        )}
                        {offering.nextAvailableSlot && (
                          <LnBadge variant="info">
                            Próximo: {formatDate(offering.nextAvailableSlot)}
                          </LnBadge>
                        )}
                        {offering.requiresAppointment && !offering.nextAvailableSlot && (
                          <LnBadge variant="warning">Sin agenda activa</LnBadge>
                        )}
                      </div>
                    </div>
                    <span aria-hidden className="text-sm text-[var(--color-ln-azul)] shrink-0 mt-1">
                      Reservar →
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </LnCardBody>
      </LnCard>
    </section>
  );
}
