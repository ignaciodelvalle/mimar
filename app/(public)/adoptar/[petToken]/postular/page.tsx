import { cookies } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { and, eq, isNull } from "drizzle-orm";

import { attachments, db, organizations, ownerships, pets, profiles } from "@/db";
import { APPLY_INTENT_COOKIE_NAME, validateApplyIntentToken } from "@/lib/domain/apply-intent";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { petPhotoUrl } from "@/lib/infra/storage";
import { createClient } from "@/lib/supabase/server";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";

import { ApplicationForm } from "./ApplicationForm";

// Gate page for the adoption application form (spec
// adoption-listing-public §8 + Fase 5). Five checks run in order:
//
//   1. Auth — anonymous → redirect to /login with returnTo so the loop
//      survives expired sessions.
//   2. Institutional reject — admin/govt cannot adopt; render a clear
//      message instead of a 403.
//   3. Listability — same predicate as queryAdoptionListing / ficha page /
//      startApplyIntentAction. If the pet went off-listing between CTA
//      and arrival, surface a friendly notice rather than 404'ing.
//   4. Apply-intent cookie — optional. Verify (signed against the
//      petToken so a pet-A cookie can't open pet-B's form), then clear.
//   5. Idempotency — if the applicant already has an unresolved
//      `_submitted` for this pet, render the "ya postulaste" message
//      instead of letting them re-submit. The submit action also blocks
//      double-writes, but checking here gives a clean UX.

export const dynamic = "force-dynamic";

export default async function PostularPage({
  params,
}: {
  params: Promise<{ petToken: string }>;
}) {
  const { petToken } = await params;
  const returnTo = `/adoptar/${petToken}/postular`;

  // 1) Auth.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/iniciar-sesion?intent=apply&returnTo=${encodeURIComponent(returnTo)}`);
  }

  // 2) Institutional reject.
  const [profile] = await db
    .select({
      accountType: profiles.accountType,
      displayName: profiles.displayName,
      phone: profiles.phone,
    })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);
  if (profile?.accountType === "institutional") {
    return <InstitutionalBlocked petToken={petToken} />;
  }

  // 3) Listability.
  const [row] = await db
    .select({ pet: pets, org: organizations, primaryPhotoStoragePath: attachments.storagePath })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .innerJoin(organizations, eq(organizations.id, ownerships.ownerOrganizationId))
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .where(
      and(
        // PO-4: soft-deleted pets do not resolve publicly.
        publicPetByToken(petToken),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (!row) notFound();
  const { pet, org } = row;
  const petPhotoUrlValue = petPhotoUrl(row.primaryPhotoStoragePath);
  const isListable =
    pet.adoptionListedAt !== null &&
    pet.adoptionListingPausedAt === null &&
    pet.status !== "deceased" &&
    pet.status !== "lost" &&
    pet.adoptionEligible === true &&
    pet.inCustodyDispute !== true &&
    pet.rabiesObservationStatus !== "in_progress" &&
    org.verified &&
    (org.orgType === "shelter" || org.orgType === "rescue_network");
  if (!isListable) {
    return <NoLongerAvailable name={pet.name} />;
  }

  // 4) Apply-intent cookie — read only. Next 15 forbids cookie mutation in
  // Server Components; cleanup happens in submitAdoptionApplicationAction
  // (success path) and in dismissApplyIntentAction (banner X). The signed
  // cookie's 15min TTL also covers the "user bails forever" case.
  const cookieStore = await cookies();
  const intentCookie = cookieStore.get(APPLY_INTENT_COOKIE_NAME);
  const intentExpired = intentCookie
    ? !validateApplyIntentToken(petToken, intentCookie.value)
    : false;

  // 5) Idempotency — render "ya postulaste" if there's an unresolved
  // application from this applicant for this pet. findExistingApplication is
  // the canonical predicate (used by the submit use-case too): it checks for
  // an adoption_application_resolved event (the real event type — approved,
  // rejected, or withdrawn all count) referencing the application. A
  // RESOLVED application (e.g. rejected) must NOT block a new one — only a
  // still-pending application does.
  const pending = await AdoptionRepository.findExistingApplication(pet.id, user.id);
  if (pending) {
    return <AlreadyApplied name={pet.name} />;
  }

  return (
    <main
      className="min-h-screen"
      style={{ background: "var(--color-ln-paper)", fontFamily: "var(--font-ln-sans)" }}
    >
      {/* Guilloché accent bar */}
      <div
        aria-hidden="true"
        className="h-[4px]"
        style={{
          background:
            "repeating-linear-gradient(90deg,var(--color-ln-azul) 0 2px,transparent 2px 4px),var(--color-ln-celeste)",
        }}
      />

      <div className="max-w-2xl mx-auto px-6 py-7 space-y-[18px]">
        {/* Back link */}
        <Link
          href={`/adoptar/${petToken}`}
          className="inline-block font-ln-mono text-sm uppercase tracking-[.06em] no-underline hover:text-[var(--color-ln-ink-2)]"
          style={{ color: "var(--color-ln-mute)" }}
        >
          ← Volver a la ficha
        </Link>

        {/* Pet context strip */}
        <div
          className="flex items-center gap-3.5 rounded-[var(--radius-lg)] border px-[18px] py-4"
          style={{
            background: "var(--color-ln-card)",
            borderColor: "var(--color-ln-line)",
          }}
        >
          {/* Pet thumbnail */}
          <div
            className="flex-shrink-0 w-[64px] h-[64px] rounded-[var(--radius-lg)] overflow-hidden border"
            style={{
              background:
                "repeating-linear-gradient(135deg,var(--pattern-no-photo-a) 0 7px,var(--pattern-no-photo-b) 7px 14px)",
              borderColor: "var(--color-ln-line)",
            }}
          >
            {petPhotoUrlValue ? (
              <Image
                src={petPhotoUrlValue}
                alt={pet.name}
                fill
                sizes="64px"
                className="object-cover"
              />
            ) : (
              <div
                className="w-full h-full grid place-items-center font-ln-serif text-title font-semibold"
                style={{ color: "var(--color-ln-mute)" }}
              >
                {pet.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <div>
            <p
              className="mb-1 font-ln-mono text-xs font-semibold uppercase tracking-[.14em]"
              style={{ color: "var(--color-ln-mute)" }}
            >
              Postulación de adopción
            </p>
            <p
              className="m-0 font-ln-serif font-semibold text-title tracking-[-0.015em]"
              style={{ color: "var(--color-ln-ink)" }}
            >
              Adoptar a {pet.name}
            </p>
            <p className="mt-0.5 text-sm" style={{ color: "var(--color-ln-mute)" }}>
              {org.displayName}
            </p>
          </div>
        </div>

        {/* Contact card — what the refugio will see */}
        <div
          className="rounded-[var(--radius-lg)] border px-[18px] py-3.5"
          style={{
            background: "var(--color-ln-stripe)",
            borderColor: "var(--color-ln-line-2)",
          }}
        >
          <p
            className="mb-1.5 font-ln-mono text-xs font-semibold uppercase tracking-[.12em]"
            style={{ color: "var(--color-ln-mute)" }}
          >
            Lo que verá el refugio de vos
          </p>
          <div className="space-y-[3px]">
            <p className="text-md font-semibold" style={{ color: "var(--color-ln-ink)" }}>
              {profile?.displayName ?? "(sin nombre)"}
            </p>
            <p className="text-sm" style={{ color: "var(--color-ln-ink-2)" }}>
              {user.email}
            </p>
            {profile?.phone && (
              <p className="text-sm" style={{ color: "var(--color-ln-ink-2)" }}>
                {profile.phone}
              </p>
            )}
          </div>
        </div>

        {intentExpired && (
          <output
            className="block rounded-[var(--radius-md)] border border-l-[4px] px-4 py-3.5 text-md"
            style={{
              background: "var(--color-ln-celeste-050)",
              borderColor: "var(--color-ln-celeste-100)",
              borderLeftColor: "var(--color-ln-azul)",
              color: "var(--color-ln-ink-2)",
            }}
          >
            Tu intención de postulación expiró, pero tu cuenta sigue activa. Podés seguir desde acá
            sin problema.
          </output>
        )}

        <ApplicationForm
          petPublicToken={petToken}
          petName={pet.name}
          applicantEmail={user.email ?? ""}
        />
      </div>
    </main>
  );
}

function InstitutionalBlocked({ petToken }: { petToken: string }) {
  return (
    <main
      className="min-h-screen"
      style={{ background: "var(--color-ln-paper)", fontFamily: "var(--font-ln-sans)" }}
    >
      <div
        aria-hidden="true"
        className="h-[4px]"
        style={{
          background:
            "repeating-linear-gradient(90deg,var(--color-ln-azul) 0 2px,transparent 2px 4px),var(--color-ln-celeste)",
        }}
      />
      <div className="max-w-md mx-auto px-6 py-16 text-center space-y-[16px]">
        <h1
          className="font-ln-serif font-semibold text-3xl tracking-[-0.02em]"
          style={{ color: "var(--color-ln-ink)" }}
        >
          Esta cuenta no puede postularse
        </h1>
        <p className="text-md" style={{ color: "var(--color-ln-ink-2)" }}>
          Las cuentas institucionales (admin y autoridades sanitarias) no pueden postularse para
          adoptar. Si querés adoptar a título personal, creá una cuenta personal con otro email.
        </p>
        <Link
          href={`/adoptar/${petToken}`}
          className="inline-block px-5 py-[11px] rounded-[var(--radius-md)] text-md font-semibold text-white no-underline"
          style={{ background: "var(--color-ln-azul)" }}
        >
          Volver a la ficha
        </Link>
      </div>
    </main>
  );
}

function NoLongerAvailable({ name }: { name: string }) {
  return (
    <main
      className="min-h-screen"
      style={{ background: "var(--color-ln-paper)", fontFamily: "var(--font-ln-sans)" }}
    >
      <div
        aria-hidden="true"
        className="h-[4px]"
        style={{
          background:
            "repeating-linear-gradient(90deg,var(--color-ln-azul) 0 2px,transparent 2px 4px),var(--color-ln-celeste)",
        }}
      />
      <div className="max-w-md mx-auto px-6 py-16 text-center space-y-[16px]">
        <h1
          className="font-ln-serif font-semibold text-3xl tracking-[-0.02em]"
          style={{ color: "var(--color-ln-ink)" }}
        >
          {name} ya no está disponible
        </h1>
        <p className="text-md" style={{ color: "var(--color-ln-ink-2)" }}>
          La publicación cambió desde que entraste a esta página. Volvé al listado y elegí otra
          mascota.
        </p>
        <Link
          href="/adoptar"
          className="inline-block px-5 py-[11px] rounded-[var(--radius-md)] text-md font-semibold text-white no-underline"
          style={{ background: "var(--color-ln-azul)" }}
        >
          Ver otras en adopción
        </Link>
      </div>
    </main>
  );
}

function AlreadyApplied({ name }: { name: string }) {
  return (
    <main
      className="min-h-screen"
      style={{ background: "var(--color-ln-paper)", fontFamily: "var(--font-ln-sans)" }}
    >
      <div
        aria-hidden="true"
        className="h-[4px]"
        style={{
          background:
            "repeating-linear-gradient(90deg,var(--color-ln-azul) 0 2px,transparent 2px 4px),var(--color-ln-celeste)",
        }}
      />
      <div className="max-w-md mx-auto px-6 py-16 text-center space-y-[16px]">
        <h1
          className="font-ln-serif font-semibold text-3xl tracking-[-0.02em]"
          style={{ color: "var(--color-ln-ink)" }}
        >
          Ya postulaste para {name}
        </h1>
        <p className="text-md" style={{ color: "var(--color-ln-ink-2)" }}>
          El refugio recibió tu postulación y la está revisando. Te van a contactar por email cuando
          tengan novedades.
        </p>
        <Link
          href="/mis-mascotas/postulaciones"
          className="inline-block px-5 py-[11px] rounded-[var(--radius-md)] text-md font-semibold text-white no-underline"
          style={{ background: "var(--color-ln-azul)" }}
        >
          Ver mis postulaciones
        </Link>
      </div>
    </main>
  );
}
