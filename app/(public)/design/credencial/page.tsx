// One board of the credential family. Fixtures only. Not a live page.

import { credentialQrUrl } from "@/lib/infra/site-url";
import QRCode from "qrcode";

import { OwnerFicha } from "../ficha-estados/OwnerFicha";
import { FICHA_FIXTURES } from "../ficha-estados/ficha-fixtures";
import "../ficha-estados/ficha.css";
import { publicLevelSheets } from "../p-niveles/sheets";
import { gateDesignPreview } from "../preview-gate";
import { LandingSample } from "./LandingSample";
import "./showcase.css";
import "@/app/landing.css";

export const metadata = {
  title: "Vista previa · la credencial",
  robots: { index: false, follow: false },
};

const OWNER_IDS = ["al-dia", "perdida", "fallecida"] as const;

async function fixtureQr(token: string): Promise<string> {
  return QRCode.toString(credentialQrUrl(token), {
    type: "svg",
    margin: 1,
    width: 160,
    errorCorrectionLevel: "Q",
  });
}

function ownerFixture(id: (typeof OWNER_IDS)[number]) {
  const found = FICHA_FIXTURES.find((fixture) => fixture.id === id);
  if (!found) throw new Error(`ficha fixture ${id} is missing`);
  return found;
}

export default async function CredentialShowcasePage() {
  gateDesignPreview();
  const [luna, negra, pampa] = await Promise.all([
    fixtureQr("DIM-LUNA-0002"),
    fixtureQr("DIM-NEGR-0003"),
    fixtureQr("DIM-MUES-0001"),
  ]);
  const href = credentialQrUrl("DIM-MUES-0001");
  const sheets = publicLevelSheets({ luna, negra, pampa });

  return (
    <div className="fp min-h-screen bg-ln-paper py-8 font-ln-sans">
      <header className="fp-lead">
        <h1>La credencial, junta</h1>
        <p>
          El mismo papel en los tres lugares: el inicio, la credencial pública y la ficha del dueño.
          Son datos de muestra. Girar muestra el dorso.
        </p>
      </header>
      <div className="sc-row">
        <section className="sc-col" data-kind="landing" aria-labelledby="sc-inicio">
          <p className="sc-kicker" id="sc-inicio">
            Inicio
          </p>
          <LandingSample qrSvg={pampa} href={href} />
        </section>
        {sheets.map((sheet) => (
          <section className="sc-col" key={sheet.id} aria-labelledby={`sc-${sheet.id}`}>
            <p className="sc-kicker" id={`sc-${sheet.id}`}>
              Pública · {sheet.kicker}
            </p>
            {sheet.body}
          </section>
        ))}
        {OWNER_IDS.map((id) => {
          const fixture = ownerFixture(id);
          return (
            <section className="sc-col" key={id} aria-labelledby={`sc-dueno-${id}`}>
              <p className="sc-kicker" id={`sc-dueno-${id}`}>
                Dueño · {fixture.kicker}
              </p>
              <OwnerFicha fixture={fixture} qrSvg={pampa} width="phone" />
            </section>
          );
        })}
      </div>
    </div>
  );
}
