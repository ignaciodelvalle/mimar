// Design preview only — not the live /p/ credential.
// The right-hand cell follows resolveCredentialRightCell: QR, ping, or nothing.

import type { ReactNode } from "react";

import { credentialQrUrl } from "@/lib/infra/site-url";
import QRCode from "qrcode";

import { gateDesignPreview } from "../preview-gate";
import { publicLevelSheets } from "./sheets";

export const metadata = {
  title: "Vista previa · niveles /p/",
  robots: { index: false, follow: false },
};

function Example({
  kicker,
  note,
  children,
}: {
  kicker: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-14">
      <p className="mb-1 font-ln-mono text-xs tracking-[.08em] text-ln-mute uppercase">{kicker}</p>
      <p className="mb-4 text-sm text-ln-ink-2">{note}</p>
      {children}
    </section>
  );
}

async function fixtureQr(token: string): Promise<string> {
  return QRCode.toString(credentialQrUrl(token), {
    type: "svg",
    margin: 1,
    width: 160,
    errorCorrectionLevel: "Q",
  });
}

export default async function PublicLevelsPreviewPage() {
  gateDesignPreview();

  const [luna, negra, pampa] = await Promise.all([
    fixtureQr("DIM-LUNA-0002"),
    fixtureQr("DIM-NEGR-0003"),
    fixtureQr("DIM-MUES-0001"),
  ]);
  const sheets = publicLevelSheets({ luna, negra, pampa });

  return (
    <div className="min-h-screen bg-ln-paper px-4 py-8 font-ln-sans">
      <div className="mx-auto max-w-[460px]">
        <h1 className="mb-2 font-ln-serif text-xl text-ln-ink">Vista previa — no es /p/ real</h1>
        <p className="mb-10 text-sm leading-relaxed text-ln-ink-2">
          La tarjeta es el documento. Las acciones van debajo. La celda derecha es el QR de esa
          credencial, el ping si está perdida y hay un punto, o nada si falleció. Nivel 2 es un chip
          al lado de la situación, no la celda.
        </p>
        {sheets.map((sheet) => (
          <Example key={sheet.id} kicker={sheet.kicker} note={sheet.note}>
            {sheet.body}
          </Example>
        ))}
      </div>
    </div>
  );
}
