// Design preview of the owner's pet profile. Not the live page.
// The PO approves this before it is wired into /mis-mascotas.

import { credentialQrUrl } from "@/lib/infra/site-url";
import QRCode from "qrcode";

import { gateDesignPreview } from "../preview-gate";
import { OwnerFicha } from "./OwnerFicha";
import { FICHA_FIXTURES } from "./ficha-fixtures";
import "./ficha.css";

export const metadata = {
  title: "Vista previa · ficha del dueño",
  robots: { index: false, follow: false },
};

export default async function OwnerFichaPreviewPage() {
  gateDesignPreview();
  const qrSvg = await QRCode.toString(credentialQrUrl("DIM-MUES-0001"), {
    type: "svg",
    margin: 1,
    width: 160,
    errorCorrectionLevel: "Q",
  });

  return (
    <div className="fp min-h-screen bg-ln-paper py-8 font-ln-sans">
      <header className="fp-lead">
        <h1>Ficha del dueño — vista previa</h1>
        <p>
          Mismo papel que la credencial pública. El dueño ve más: cumplimiento, avisos y la libreta
          al girar. No es la página real.
        </p>
        <ul className="fp-answers">
          <li>Una sola voz fuerte: la situación. El resto son filas con ícono y texto.</li>
          <li>Al día no lleva chip. El cumplimiento dice cómo está el papeleo.</li>
          <li>Primeros pasos es una lista, no un alerta.</li>
          <li>Lo que no se puede hacer queda gris, con el motivo.</li>
          <li>Fallecida: sin celda y sin acciones.</li>
        </ul>
      </header>
      <div className="fp-board">
        {FICHA_FIXTURES.map((fixture) => (
          <section className="fp-block" key={fixture.id} aria-labelledby={`fp-${fixture.id}`}>
            <p className="fp-kicker" id={`fp-${fixture.id}`}>
              {fixture.kicker}
            </p>
            <p className="fp-note">{fixture.note}</p>
            <div className="fp-pair">
              <OwnerFicha fixture={fixture} qrSvg={qrSvg} width="phone" />
              <OwnerFicha fixture={fixture} qrSvg={qrSvg} width="desk" />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
