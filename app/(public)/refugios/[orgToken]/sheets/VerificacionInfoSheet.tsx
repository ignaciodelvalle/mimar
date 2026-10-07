"use client";

import { Sheet } from "@/components/ui/VaulSheet";
import { CONTACT_EMAILS, mailtoHref } from "@/lib/ui/contact";
import { buildCloseSheetUrl } from "@/lib/ui/sheet-helpers";
import { closeSheetNav } from "@/lib/ui/sheet-nav";
import { AR_TIME_ZONE } from "@/lib/utils/format";
import {
  PUBLIC_VERIFIER_LABEL,
  type PublicVerificationPath,
} from "@/src/modules/organizations/domain/public-directory";
import { usePathname, useSearchParams } from "next/navigation";

// "Qué significa verificado" — educational text. No form. Handoff P2-9.

interface Props {
  /** How the org was verified — an institution, never a person's name. */
  verifiedVia: PublicVerificationPath;
  verifiedAt: Date | null;
  /**
   * A clinic listed in the directory (migration 0283) is verified on other
   * grounds than a shelter and takes no adoption applications, so neither of
   * the two rehoming paragraphs is true of it.
   */
  clinic?: boolean;
}

function formatVerifiedDate(d: Date): string {
  return d.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: AR_TIME_ZONE,
  });
}

export function VerificacionInfoSheet({ verifiedVia, verifiedAt, clinic = false }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const open = searchParams.get("sheet") === "verificacion-info";

  return (
    <Sheet
      id="verificacion-info"
      title="¿Qué significa que esté verificado?"
      open={open}
      onClose={() => closeSheetNav(buildCloseSheetUrl(pathname, searchParams))}
      size="md"
    >
      <div className="space-y-4 text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
        {/* "Organización", not "refugio": /refugios profiles also cover
            rescue networks (and could cover other org types), and the badge
            copy was calling a Red de Rescate a refugio (9-role external run,
            2026-08-18). */}
        {clinic ? (
          <p>
            <span className="font-semibold text-[var(--color-ln-ink)]">Verificado por miMAR</span>{" "}
            significa que miMAR confirmó esta veterinaria: la revisó el equipo, o la dio de alta un
            o una profesional con la matrícula veterinaria verificada. Aparece en el directorio
            porque la veterinaria eligió estar.
          </p>
        ) : (
          <>
            <p>
              <span className="font-semibold text-[var(--color-ln-ink)]">Verificado por miMAR</span>{" "}
              significa que el equipo confirmó que esta organización existe, tiene personería
              jurídica activa o un convenio con autoridad sanitaria, y que el contacto que figura
              responde.
            </p>
            <p>
              Las postulaciones de adopción que mandás desde miMAR llegan directo al equipo de la
              organización. Coordinan los próximos pasos por email con cada candidato. miMAR no
              interviene en la decisión final ni en la entrega del animal.
            </p>
          </>
        )}
        <p>
          Si tenés dudas sobre esta organización en particular o pensás que algo no encaja,
          escribinos a{" "}
          <a
            className="text-[var(--color-ln-azul)] underline"
            href={mailtoHref(CONTACT_EMAILS.general)}
          >
            {CONTACT_EMAILS.general}
          </a>
          .
        </p>

        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-3 text-xs text-[var(--color-ln-ink-2)] space-y-1">
          <p className="text-xs uppercase tracking-wider text-[var(--color-ln-mute)]">
            Datos de verificación
          </p>
          <p>
            Verificó:{" "}
            <span className="font-medium text-[var(--color-ln-ink)]">
              {PUBLIC_VERIFIER_LABEL[verifiedVia]}
            </span>
          </p>
          {verifiedAt && <p>Fecha: {formatVerifiedDate(verifiedAt)}</p>}
        </div>
      </div>
    </Sheet>
  );
}
