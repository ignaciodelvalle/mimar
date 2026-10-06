"use client";

// Landing carnet faces — paints CredentialDocumentSlotsV1 with the hero's
// existing CSS classes. Motion (tilt / float / flick) wraps this from
// LandingHero; this file never writes a transform.

import { CardTurnButton } from "@/components/credential/CardTurnButton";
import type { CredentialDocumentSlotsV1 } from "@dim/contract/credential";
import Image from "next/image";
import Link from "next/link";

/** Ghost plaques in the blue band. Size lives in CSS; this is only how many
 *  sit on their own plane. They must not overlap. */
const BAND_GHOST_MARKS = [0, 1, 2, 3] as const;

function BandGhostMarks() {
  return (
    <span className="lp-hcard-sec" aria-hidden="true">
      {BAND_GHOST_MARKS.map((n) => (
        <span key={n} className="lp-hcard-sec-mark" />
      ))}
    </span>
  );
}

function BandJoin() {
  return <div className="lp-hcard-tone" aria-hidden="true" />;
}

function BandHead({
  doctype,
  flipLabel,
  flipDirection,
  onFlip,
}: {
  /** Null when the chrome recipe has no title for this face: nothing is printed. */
  doctype: string | null;
  flipLabel: string;
  flipDirection: "forward" | "reverse";
  onFlip: () => void;
}) {
  return (
    <div className="lp-hcard-head">
      <span className="lp-hcard-head-balance lp-hcard-latent-mark" aria-hidden="true" />
      {/* The head is a three-track grid; an empty middle span keeps the flip
          control in its own track when there is no doctype to print. */}
      {doctype === null ? (
        <span aria-hidden="true" />
      ) : (
        <span className="lp-hcard-doctype">{doctype}</span>
      )}
      <span className="lp-hcard-trim-r">
        <FlipButton label={flipLabel} direction={flipDirection} onFlip={onFlip} />
      </span>
    </div>
  );
}

function FlipButton({
  label,
  direction,
  onFlip,
}: {
  label: string;
  direction: "forward" | "reverse";
  onFlip: () => void;
}) {
  return (
    <CardTurnButton skin="lp-hcard-flip" label={label} title={label} onClick={onFlip}>
      {direction === "forward" ? "↻" : "↺"}
    </CardTurnButton>
  );
}

function InertQrGlyph() {
  return (
    <span className="lp-hcard-qr" aria-hidden="true">
      <svg viewBox="0 0 29 29" fill="none">
        <title>Ilustración de un código QR</title>
        <g fill="var(--color-ln-line)">
          <path d="M0 0h9v9H0zM20 0h9v9h-9zM0 20h9v9H0z" />
        </g>
        <g fill="var(--color-ln-card)">
          <path d="M2 2h5v5H2zM22 2h5v5h-5zM2 22h5v5H2z" />
        </g>
        <g fill="var(--color-ln-line)">
          <path d="M3.5 3.5h2v2h-2zM23.5 3.5h2v2h-2zM3.5 23.5h2v2h-2z" />
          <path d="M12 0h2v2h-2zM12 4h2v2h-2zM12 8h2v2h-2zM16 12h2v2h-2zM12 12h2v2h-2zM8 12h2v2h-2zM4 12h2v2h-2zM0 12h2v2H0zM20 12h2v2h-2zM24 12h2v2h-2zM12 16h2v2h-2zM12 20h2v2h-2zM12 24h2v2h-2zM16 16h2v2h-2zM20 20h2v2h-2zM24 24h2v2h-2zM16 24h2v2h-2zM24 16h2v2h-2z" />
        </g>
      </svg>
    </span>
  );
}

export function CredentialCarnetFaces({
  slots,
  qrSvg,
  photoAlt,
  onFlip,
  contextKey,
}: {
  slots: CredentialDocumentSlotsV1;
  qrSvg: string | null;
  photoAlt: string;
  onFlip: () => void;
  contextKey: number;
}) {
  const scannable = qrSvg !== null && slots.identity.qrUrl !== null;
  const rows = slots.back?.rows ?? [];
  const mrz = slots.mrz;

  return (
    <>
      <div className="lp-hcard-front">
        <div className="lp-hcard-band">
          <BandGhostMarks />
          <span className="lp-hcard-latent" aria-hidden="true" />
          <BandHead
            doctype={slots.chrome.subtitleFront}
            flipLabel="Girar credencial"
            flipDirection="forward"
            onFlip={onFlip}
          />
        </div>
        <BandJoin />

        <div className="lp-hcard-body">
          <span className="lp-hcard-photo">
            {slots.identity.photoUrl ? (
              <Image
                src={slots.identity.photoUrl}
                alt={photoAlt}
                fill
                sizes="120px"
                priority
                draggable={false}
                className="object-cover"
              />
            ) : null}
            <span className="lp-hcard-ovd" aria-hidden="true" />
          </span>
          <span className="lp-hcard-id">
            <span className="lp-hcard-name">{slots.identity.name}</span>
            <span className="lp-hcard-token">{slots.identity.publicToken}</span>
          </span>
          {scannable && slots.identity.qrUrl ? (
            <Link
              href={slots.identity.qrUrl}
              aria-label="Ver la credencial pública de demostración"
              title="Escaneame — QR real de demostración"
              className="lp-hcard-qr"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: server-generated QR SVG from the qrcode package, no user input.
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : (
            <InertQrGlyph />
          )}
        </div>

        <dl className="lp-hcard-fields">
          {slots.fields.map((f) => (
            <div key={f.id}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>

        {slots.contextLine ? (
          <div key={contextKey} className="lp-hcard-ctx" data-section="hero-state-line">
            <span className="lp-hcard-ctx-marker" aria-hidden="true" />
            <span>
              <b className="lp-hcard-ctx-state">{slots.contextLine.stateWord}</b> ·{" "}
              {slots.contextLine.row}
            </span>
          </div>
        ) : null}

        {mrz ? (
          <div className="lp-hcard-mrz" aria-hidden="true">
            <span>{mrz[0]}</span>
            <span>{mrz[1]}</span>
          </div>
        ) : null}
      </div>

      <div className="lp-hcard-back">
        <span className="lp-hcard-shimmer" aria-hidden="true" />
        <div className="lp-hcard-libhead">
          <BandGhostMarks />
          <span className="lp-hcard-latent" aria-hidden="true" />
          <BandHead
            doctype={slots.chrome.subtitleBack}
            flipLabel="Volver a la credencial"
            flipDirection="reverse"
            onFlip={onFlip}
          />
        </div>
        <div className="lp-hcard-libmeta">
          <span className="lp-hcard-libname">{slots.identity.name}</span>
          <span className="lp-hcard-libtoken">{slots.identity.publicToken}</span>
        </div>
        {rows.map((row) => (
          <div className="lp-hcard-librow" key={`${row.what}-${row.who}`}>
            <span>
              <span className="lp-hcard-libwhat">{row.what}</span>
              <span className="lp-hcard-libwho">{row.who}</span>
            </span>
            {row.stamp ? <span className="lp-hcard-libstamp">{row.stamp}</span> : null}
          </div>
        ))}
        <div className="lp-hcard-libpaper" aria-hidden="true" />
      </div>
    </>
  );
}
