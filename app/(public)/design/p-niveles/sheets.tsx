// The public-credential examples. Shared by /design/p-niveles and the
// side-by-side showcase. Fixture paint only — not the live /p/ page.

import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";

import { PublicDocumentBand } from "@/components/credential/PublicDocumentBand";

function Photo({ letter }: { letter: string }) {
  return (
    <div className="pc-photo-mount">
      <div className="pc-photo-placeholder">
        <span className="pc-photo-placeholder-initial">{letter}</span>
      </div>
    </div>
  );
}

function QrSlot({ svg, name }: { svg: string; name: string }) {
  return (
    <div className="pc-qr-mount" data-slot="qr" role="img" aria-label={`Código QR de ${name}`}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-generated QR SVG from the qrcode package, fixture URL only. */}
      <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

function PingSlot() {
  return (
    <div className="pc-qr-mount" data-slot="ping" aria-hidden="true">
      <div className="pc-ping">
        <span className="pc-ping-grid" />
        <span className="pc-ping-dot" />
        <span className="pc-ping-ring" />
      </div>
    </div>
  );
}

export type PublicLevelSheet = {
  id: string;
  kicker: string;
  note: string;
  body: ReactNode;
};

export function publicLevelSheets(qrs: {
  luna: string;
  negra: string;
  pampa: string;
}): PublicLevelSheet[] {
  return [
    {
      id: "nivel-0",
      kicker: "Nivel 0 · viva",
      note: "QR real del token de la ficha. Hechos: Microchip solo si Sí, y Color.",
      body: (
        <>
          <div className="pc-cred" data-level="0">
            <PublicDocumentBand subtitle="Credencial pública" />
            <div className="pc-id" data-cell="qr">
              <Photo letter="L" />
              <div className="pc-id-copy">
                <h2 className="m-0 font-ln-serif text-xl text-ln-ink">Luna</h2>
                <p className="pc-id-token">DIM-LUNA-0002</p>
              </div>
              <QrSlot svg={qrs.luna} name="Luna" />
            </div>
            <div className="pc-name">
              <p className="pc-name-meta">Perro · Mixto / Cruza · Hembra · 3 años</p>
            </div>
            <dl className="pc-stamps">
              <div>
                <dt>Microchip</dt>
                <dd>Sí</dd>
              </div>
              <div>
                <dt>Color</dt>
                <dd>Negra</dd>
              </div>
            </dl>
          </div>
          <div className="ln-actionbar mt-3">
            <span className="ln-act">
              <Icon name="ubicacion" size="sm" decorative />
              ¿La encontraste?
            </span>
          </div>
        </>
      ),
    },
    {
      id: "fallecida",
      kicker: "Nivel 0 · fallecida",
      note: "Sin celda. El nombre queda centrado. Sin fila de acciones.",
      body: (
        <div className="pc-cred" data-situation="fallecida" data-level="0">
          <PublicDocumentBand subtitle="Credencial pública" />
          <div className="pc-id" data-cell="none">
            <Photo letter="L" />
            <div className="pc-id-copy">
              <h2 className="m-0 font-ln-serif text-xl text-ln-ink">Laika</h2>
              <p className="pc-id-token">DIM-MUES-0015</p>
            </div>
          </div>
          <div className="pc-name">
            <p className="pc-name-meta">Perro · Mixto / Cruza · Hembra · 3 años</p>
          </div>
          <div className="pc-chips">
            <span className="pc-sit-chip">Fallecida</span>
          </div>
        </div>
      ),
    },
    {
      id: "perdida-punto",
      kicker: "Nivel 1 · perdida con punto",
      note: "Ping en la celda (no Google Maps). Hechos adentro. Lo tengo · Lo vi · Llamar afuera.",
      body: (
        <>
          <div className="pc-cred" data-situation="perdida" data-level="1">
            <PublicDocumentBand subtitle="Credencial pública" />
            <div className="pc-id" data-cell="ping">
              <Photo letter="F" />
              <div className="pc-id-copy">
                <h2 className="m-0 font-ln-serif text-xl text-ln-ink">Firulais</h2>
                <p className="pc-id-token">DIM-3MF8-6674</p>
              </div>
              <PingSlot />
            </div>
            <div className="pc-name">
              <p className="pc-name-meta">Perro · Caniche · Macho</p>
            </div>
            <div className="pc-chips">
              <span className="pc-sit-chip" role="alert">
                <Icon name="alert-triangle" size="sm" decorative />
                Perdido
                <span className="pc-sit-chip-recency">· hace 22 h</span>
              </span>
            </div>
            <p className="px-4 pb-1 text-sm text-ln-ink-2">Lo busca Martín.</p>
            <p className="px-4 pb-3 text-sm text-ln-ink">
              Palermo, CABA · Av. Santa Fe al 3200 · hace 22 h
            </p>
            <dl className="pc-stamps">
              <div>
                <dt>Microchip</dt>
                <dd>Sí</dd>
              </div>
              <div>
                <dt>Color</dt>
                <dd>Marrón</dd>
              </div>
            </dl>
          </div>
          <div className="ln-actionbar mt-3">
            <span className="ln-act !border-ln-azul !bg-ln-azul !text-white">
              <Icon name="ubicacion" size="sm" decorative />
              Lo tengo conmigo
            </span>
            <span className="ln-act">
              <Icon name="ojo" size="sm" decorative />
              Lo vi cerca de acá
            </span>
            <span className="ln-act">
              <Icon name="telefono" size="sm" decorative />
              Llamar
            </span>
          </div>
        </>
      ),
    },
    {
      id: "perdida-sin-punto",
      kicker: "Nivel 1 · perdida sin punto",
      note: "Sin coordenada no hay ping: la celda es el QR. Llamar no está. Email es un renglón.",
      body: (
        <>
          <div className="pc-cred" data-situation="perdida" data-level="1">
            <PublicDocumentBand subtitle="Credencial pública" />
            <div className="pc-id" data-cell="qr">
              <Photo letter="N" />
              <div className="pc-id-copy">
                <h2 className="m-0 font-ln-serif text-xl text-ln-ink">Negra</h2>
                <p className="pc-id-token">DIM-NEGR-0003</p>
              </div>
              <QrSlot svg={qrs.negra} name="Negra" />
            </div>
            <div className="pc-name">
              <p className="pc-name-meta">Gato · Común · Hembra · 2 años</p>
            </div>
            <div className="pc-chips">
              <span className="pc-sit-chip" role="alert">
                Perdida
                <span className="pc-sit-chip-recency">· hace 4 d</span>
              </span>
            </div>
            <p className="px-4 pb-3 text-sm text-ln-ink-2">Lo busca Ana.</p>
          </div>
          <div className="ln-actionbar mt-3">
            <span className="ln-act !border-ln-azul !bg-ln-azul !text-white">
              <Icon name="ubicacion" size="sm" decorative />
              La tengo conmigo
            </span>
            <span className="ln-act">
              <Icon name="ojo" size="sm" decorative />
              La vi cerca de acá
            </span>
          </div>
          <p className="mt-2 text-sm text-ln-ink-2">Escribirle a Ana</p>
        </>
      ),
    },
    {
      id: "nivel-2",
      kicker: "Nivel 2 · QR + chip",
      note: "Muestra de diseño: slots, MRZ y giro quedaron en pausa por privacidad (2026-10-06) y /p/ no los dibuja. El formulario queda afuera.",
      body: (
        <>
          <div className="pc-cred" data-level="2">
            <PublicDocumentBand
              subtitle="Credencial pública"
              flip={
                <span className="pc-band-flip" aria-hidden="true">
                  ↻
                </span>
              }
            />
            <div className="pc-id" data-cell="qr">
              <Photo letter="P" />
              <div className="pc-id-copy">
                <h2 className="m-0 font-ln-serif text-xl text-ln-ink">Pampa</h2>
                <p className="pc-id-token">DIM-MUES-0001</p>
              </div>
              <QrSlot svg={qrs.pampa} name="Pampa" />
            </div>
            <div className="pc-name">
              <p className="pc-name-meta">Perro · Caniche · Hembra · 4 años</p>
            </div>
            <div className="pc-chips">
              <span
                className="pc-tier2-chip"
                title="El dueño habilitó la libreta médica de forma permanente"
              >
                Nivel 2 · Datos médicos
              </span>
            </div>
            <dl className="pc-slots">
              <div>
                <dt>Microchip</dt>
                <dd>Sí</dd>
              </div>
              <div>
                <dt>Color</dt>
                <dd>Blanco</dd>
              </div>
              <div>
                <dt>Provincia</dt>
                <dd>CABA</dd>
              </div>
              <div>
                <dt>Localidad</dt>
                <dd>Belgrano</dd>
              </div>
            </dl>
            <div className="pc-facts">
              <div className="pc-fact-grid">
                <dl className="pc-fact" data-tone="warn">
                  <dt>Vacunación</dt>
                  <dd>1</dd>
                  <dd className="pc-fact-sub">2 faltantes</dd>
                </dl>
                <dl className="pc-fact" data-tone="ok">
                  <dt>Esterilización</dt>
                  <dd>Sí</dd>
                  <dd className="pc-fact-sub">Castrada</dd>
                </dl>
              </div>
            </div>
            <div className="pc-mrz" aria-hidden="true">
              <span>miMAR&lt;PAMP0001&lt;&lt;PAMPA&lt;&lt;&lt;&lt;</span>
              <span>PERRO&lt;CANICHE&lt;&lt;H&lt;202211&lt;&lt;&lt;&lt;&lt;</span>
            </div>
          </div>
          <div className="ln-actionbar mt-3">
            <span className="ln-act">
              <Icon name="ubicacion" size="sm" decorative />
              ¿La encontraste?
            </span>
          </div>
        </>
      ),
    },
  ];
}
