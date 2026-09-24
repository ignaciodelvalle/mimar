// Public-facing PPP badge — Tier 0 public credential page.
//
// Renders an amber warning card when the pet is subject to the PPP regime
// (Ley CABA 4078 / Ley Prov 14.107). This status is public by law — the
// public has a right to know (Art. 4, Ley CABA 4078).
//
// Intentionally minimal: no attestation block, no requirements list, no CTAs.
// Those are owner-context concerns shown only on the owner profile (PpPCard).

import { Icon } from "@/components/Icon";
import { buildPppDisclaimerLine, buildPppHeadline } from "@/lib/domain/ppp-public-badge";

interface Props {
  petName: string;
  breed: string | null;
}

// Es una TARJETA, no un chip: un <section> con encabezado, cuerpo y padding
// propio. El nombre del archivo dice "Badge", y por eso el barrido de E-2 lo
// contó como una sexta geometría de la familia de chips. La geometría correcta
// para una superficie con contenido es --radius-card, que es exactamente lo que
// el `rounded-2xl` anterior ya rendía: cambia el TOKEN, no el píxel.
export function PppPublicBadge({ petName, breed }: Props) {
  return (
    <section
      aria-label="Animal Potencialmente Peligroso"
      className="rounded-[var(--radius-card)] border border-ln-warn bg-[var(--color-ln-warn-050)] p-4 space-y-2"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ln-warn ">
          <Icon name="alerta" size="sm" decorative />
          {buildPppHeadline()}
        </h2>
        <span className="text-xs font-medium uppercase tracking-wider text-ln-warn ">
          CABA: Ley 4078 · PBA: Ley 14.107
        </span>
      </header>
      <p className="text-xs text-ln-warn ">{buildPppDisclaimerLine(petName, breed)}</p>
    </section>
  );
}
