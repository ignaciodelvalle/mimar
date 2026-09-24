// /mis-mascotas/[publicToken]/chapita — self-print QR tag sheet (task #43,
// closes the physical-credential-hub Fase A gap: the interest sheet offered
// "QR imprimible en casa" with no destination).
//
// Gate: requirePetAccess + the printable_qr channel resolved for the pet's
// jurisdiction (physical_credential_channels business rule — WIRED per the
// config-theater audit). Mirrors the cartel page's structure: server-side QR
// SVG + a client preview with window.print, print CSS in real millimetres.

import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";

import { requirePetAccess } from "@/lib/infra/pet-access";
import { resolvePhysicalCredentialChannels } from "@/lib/infra/physical-credential-channels";
import { resolveSiteUrl } from "@/lib/infra/site-url";

import "./chapita-print.css";
import { ChapitaSheet } from "./ChapitaSheet";

export default async function ChapitaPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  const access = await requirePetAccess(publicToken);
  if (!access.ok) notFound();
  const { pet } = access;

  const channels = await resolvePhysicalCredentialChannels({
    country: "AR",
    province: pet.jurisdictionProvince,
    locality: pet.jurisdictionLocality,
  });

  if (!channels.printable_qr) {
    return (
      <div className="mx-auto max-w-md px-8 py-12 text-center">
        <p className="font-ln-serif text-xl font-semibold text-[var(--color-ln-ink)]">
          El QR imprimible no está habilitado en tu zona.
        </p>
        <p className="mt-1.5 text-md text-[var(--color-ln-mute)]">
          Consultá los canales disponibles para conseguir la chapita de {pet.name}.
        </p>
        <Link
          href={`/mis-mascotas/${publicToken}?sheet=chapita`}
          className="mt-5 inline-flex items-center rounded-[var(--radius-op-btn)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-4 py-2 text-md font-medium text-[var(--color-ln-ink)] no-underline transition-opacity hover:opacity-80"
        >
          Ver canales disponibles
        </Link>
      </div>
    );
  }

  // Same QR target + generation settings as the cartel and the credential —
  // including the quiet zone: margin: 0 left every other QR in the repo's
  // company (cartel, credencial, presentar, turnos all use margin: 1), but
  // THIS is the one printed at physical-tag scale (22/24/40mm, ChapitaSheet's
  // QrBlock) with no quiet zone at all — a scanner has nothing to lock onto
  // at the code's edge (PRN-4, print-surfaces audit 2026-08-04).
  const baseUrl = resolveSiteUrl();
  const qrSvg = await QRCode.toString(`${baseUrl}/p/${publicToken}`, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
  });

  return <ChapitaSheet petName={pet.name} publicToken={publicToken} qrSvg={qrSvg} />;
}
