// Modo presentación — credencial de perro de asistencia.
// Libreta Nacional redesign. Full-screen chrome-free layout preserved.
// gob-* token references replaced with LN semantic tokens.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import QRCode from "qrcode";

import { Icon } from "@/components/Icon";
import { attachments, db, petServiceDog } from "@/db";
import { requirePetAccess } from "@/lib/infra/pet-access";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { SERVICE_TYPE_LABELS } from "@/lib/infra/service-dog-labels";
import { buildPublicVerifyUrl, isCredentialPresentable } from "@/lib/infra/service-dog-presentar";
import { petPhotoUrl } from "@/lib/infra/storage";
import { formatDate } from "@/lib/utils/format";
import { and, eq } from "drizzle-orm";

export default async function AsistenciaPresentarPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  const access = await requirePetAccess(publicToken);
  if (!access.ok) notFound();
  if (access.accessPath !== "owner") notFound();

  const pet = access.pet;

  const [serviceDog] = await db
    .select()
    .from(petServiceDog)
    .where(eq(petServiceDog.petId, pet.id))
    .limit(1);

  if (!isCredentialPresentable(serviceDog ?? null)) {
    redirect(`/mis-mascotas/${publicToken}/asistencia`);
  }

  const [[photoAttachment], canonicalIds] = await Promise.all([
    pet.primaryPhotoId
      ? db
          .select({ storagePath: attachments.storagePath })
          .from(attachments)
          .where(and(eq(attachments.id, pet.primaryPhotoId)))
          .limit(1)
      : Promise.resolve([]),
    fetchActiveIdentifications(pet.id),
  ]);
  const photoUrl = petPhotoUrl(
    (photoAttachment as { storagePath?: string } | undefined)?.storagePath,
  );

  const serviceTypeLabel = SERVICE_TYPE_LABELS[serviceDog.serviceType] ?? serviceDog.serviceType;

  const publicVerifyUrl = buildPublicVerifyUrl(publicToken);
  const qrSvg = await QRCode.toString(publicVerifyUrl, {
    type: "svg",
    margin: 1,
    width: 180,
    errorCorrectionLevel: "M",
  });

  // The ground below is ln-paper, not the undeclared ln-canvas it used to name:
  // nothing declares --color-ln-canvas, so this screen drew with no background
  // at all. "canvas" is the NATIVE side's name for the same value (theme.ts maps
  // canvas -> LN_COLORS.paper); on the web the token is ln-paper.
  return (
    <main className="flex min-h-screen flex-col bg-[var(--color-ln-paper)] text-[var(--color-ln-ink)]">
      {/* Minimal top bar */}
      <div className="px-4 pt-4">
        <Link
          href={`/mis-mascotas/${publicToken}/asistencia`}
          className="font-ln-mono text-sm text-[var(--color-ln-mute)] no-underline hover:text-[var(--color-ln-ink-2)]"
        >
          ← Volver
        </Link>
      </div>
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-6 px-6 py-8">
        {/* Credential title */}
        <div className="text-center">
          <p className="font-ln-mono text-xs uppercase tracking-[.3em] text-[var(--color-ln-mute)]">
            Credencial de perro de asistencia
          </p>
          <p className="mt-[3px] font-ln-mono text-sm font-semibold uppercase tracking-[.1em] text-[var(--color-ln-ok)]">
            Ley 26.858
          </p>
        </div>

        {/* Photo */}
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl}
            alt={pet.name}
            className="h-[144px] w-[144px] rounded-full object-cover shadow-md ring-4 ring-[var(--color-ln-ok)]"
          />
        ) : (
          <div className="flex h-[144px] w-[144px] items-center justify-center rounded-full bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)] shadow-md ring-4 ring-[var(--color-ln-ok)]">
            <Icon name="huella" size={72} decorative />
          </div>
        )}

        {/* Pet name and service type */}
        <div className="text-center">
          <h1 className="font-ln-serif text-5xl font-semibold tracking-tight text-[var(--color-ln-ink)]">
            {pet.name}
          </h1>
          <p className="mt-1 text-lg text-[var(--color-ln-ok)]">{serviceTypeLabel}</p>
        </div>

        {/* Credential fields */}
        <dl className="w-full divide-y divide-[var(--color-ln-line)]">
          {canonicalIds.microchip && (
            <div className="flex justify-between py-2.5">
              <dt className="text-md text-[var(--color-ln-mute)]">Microchip</dt>
              <dd className="font-ln-mono text-md text-[var(--color-ln-ink)]">
                {canonicalIds.microchip.code}
              </dd>
            </div>
          )}
          {serviceDog.rupgaCredential && (
            <div className="flex justify-between py-2.5">
              <dt className="text-md text-[var(--color-ln-mute)]">RUPGA</dt>
              <dd className="font-ln-mono text-md text-[var(--color-ln-ink)]">
                {serviceDog.rupgaCredential}
              </dd>
            </div>
          )}
          <div className="flex justify-between py-2.5">
            <dt className="text-md text-[var(--color-ln-mute)]">Centro de entrenamiento</dt>
            <dd className="max-w-[55%] text-right text-md text-[var(--color-ln-ink)]">
              {serviceDog.trainingCenter}
            </dd>
          </div>
          {serviceDog.credentialIssueDate && (
            <div className="flex justify-between py-2.5">
              <dt className="text-md text-[var(--color-ln-mute)]">Emitida</dt>
              <dd className="text-md text-[var(--color-ln-ink)]">
                {formatDate(serviceDog.credentialIssueDate)}
              </dd>
            </div>
          )}
          {serviceDog.credentialExpiryDate && (
            <div className="flex justify-between py-2.5">
              <dt className="text-md text-[var(--color-ln-mute)]">Vence</dt>
              <dd className="text-md text-[var(--color-ln-ink)]">
                {formatDate(serviceDog.credentialExpiryDate)}
              </dd>
            </div>
          )}
        </dl>

        {/* Legal text */}
        <p className="max-w-sm text-center text-sm leading-relaxed text-[var(--color-ln-mute)]">
          Esta credencial habilita el acceso, deambulación y permanencia con este perro en todos los
          espacios públicos y privados de uso público (Arts. 1 y 7, Ley 26.858).
        </p>

        {/* QR toggle — server-rendered SVG, native disclosure */}
        <details className="w-full text-center">
          <summary className="cursor-pointer font-ln-mono text-sm text-[var(--color-ln-azul)] select-none hover:underline">
            Mostrar QR de verificación
          </summary>
          <div className="mt-3 flex flex-col items-center gap-2">
            <div
              className="rounded-[var(--radius-sm)] bg-white p-2 shadow-sm"
              aria-label={`QR de verificación para ${publicVerifyUrl}`}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: server-generated SVG from the qrcode library
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
            <p className="max-w-xs break-all font-ln-mono text-xs text-[var(--color-ln-mute)]">
              {publicVerifyUrl}
            </p>
          </div>
        </details>
      </div>
    </main>
  );
}
