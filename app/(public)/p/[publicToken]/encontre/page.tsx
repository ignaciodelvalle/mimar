// "La tengo conmigo" public route — heavier finder flow.
// The finder claims physical custody of the pet and the owner needs to arrange
// pickup. Only reachable when pet.status === 'lost' AND
// pet.allowFinderFormWhenLost === true.
//
// Gate hierarchy:
//   1. Pet not found                 → notFound() (hard 404).
//   2. Pet not lost                  → degraded "no está perdida" view.
//   3. allowFinderFormWhenLost=false → explanatory view with tel:/mailto: links
//      (respects disclosePhoneWhenLost / discloseEmailWhenLost prefs).
//   4. Happy path                    → header + FinderInPossessionForm.
//
// Logged-in detection: getUser() without redirect. PO decision 2026-07-16 —
// the form is NEVER prefilled from the session (the finder types everything by
// hand); the session is only used to render the "¿No sos vos? Salí de la
// sesión" advisory banner (with the session's display name).

import { and, asc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Icon } from "@/components/Icon";
import { attachments, db, ownerships, pets, profiles } from "@/db";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { isPublicTokenReadThrottled } from "@/lib/infra/public-token-throttle";
import { reportError } from "@/lib/infra/report-error";
import { petPhotoUrl } from "@/lib/infra/storage";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { DISPUTE_TIP_HEADING, DISPUTE_TIP_INTRO } from "@/lib/ui/dispute-copy";
import { foundPossessivePhrase } from "@/lib/utils/format";

import { DisputeTipForm } from "../DisputeTipForm";
import { FinderInPossessionForm } from "./FinderInPossessionForm";

export const dynamic = "force-dynamic";

export default async function FinderInPossessionPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  // Per-IP read limit BEFORE the token lookup. This route needs it more than
  // its siblings: the "allowFinderFormWhenLost=false" branch below renders the
  // owner's tel:/mailto: and calls the Supabase ADMIN API to resolve their
  // email, so without a limiter an anonymous caller had an unthrottled path to
  // a privileged lookup — once per request, for as many requests as they liked.
  if (await isPublicTokenReadThrottled("public_token_encontre")) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10">
        <h1 className="text-title font-semibold text-ln-ink">Demasiadas consultas</h1>
        <p className="mt-2 text-md text-ln-mute">
          Recibimos muchas consultas desde tu conexión. Esperá un momento y volvé a intentarlo.
        </p>
      </main>
    );
  }

  // Resolve the pet + primary photo in one join.
  const [petRow] = await db
    .select({ pet: pets, photo: attachments })
    .from(pets)
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    // PO-4: soft-deleted pets do not resolve publicly (gate 1 catches it).
    .where(publicPetByToken(publicToken))
    .limit(1);
  if (!petRow) notFound();

  const { pet, photo } = petRow;
  const photoUrl = petPhotoUrl(photo?.storagePath);

  // Gate 0 — custody dispute: the CHANNEL is kept, the DESTINATION moves (PO
  // decision 2026-07-30). Same reasoning as the sighting route, and this one
  // matters more: whoever reaches /encontre is holding the animal. D2 was
  // right that the relay must not run (it hands the finder's name and phone to
  // a contested owner); it was wrong to leave a promise of routing with no
  // form to write in. The neutral tip form goes here, and the submission lands
  // on the dispute case where only the reviewing authority reads it.
  // encontre/action.ts still refuses server-side — defense-in-depth for a
  // hand-rolled POST, since no UI here points at it anymore.
  if (pet.inCustodyDispute) {
    return (
      // Landing shell (AppShell variant=landing) owns #main-content + min-height.
      <div className="min-h-screen bg-[var(--color-ln-paper)] px-4 py-6">
        <div className="mx-auto max-w-md space-y-5">
          <header className="space-y-1">
            <Link
              href={`/p/${publicToken}`}
              className="text-sm text-[var(--color-ln-ink)] underline underline-offset-4"
            >
              ← Volver al perfil
            </Link>
            <h1 className="text-2xl font-semibold text-[var(--color-ln-ink)]">
              {DISPUTE_TIP_HEADING}
            </h1>
            <p className="text-sm text-[var(--color-ln-mute)]">{DISPUTE_TIP_INTRO}</p>
          </header>

          <section className="rounded-2xl bg-[var(--color-ln-card)] p-4">
            <DisputeTipForm publicToken={publicToken} />
          </section>
        </div>
      </div>
    );
  }

  // Gate 1: not lost.
  if (pet.status !== "lost") {
    return (
      // Landing shell (AppShell variant=landing) owns #main-content + min-height.
      <div className="min-h-screen bg-[var(--color-ln-paper)] px-4 py-10">
        <div className="mx-auto max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-semibold text-[var(--color-ln-ink)]">
            Esta mascota no está perdida
          </h1>
          <p className="text-sm text-[var(--color-ln-mute)]">
            El formulario de "la tengo conmigo" sólo está disponible mientras la mascota está
            marcada como perdida.
          </p>
          <Link
            href={`/p/${publicToken}`}
            className="inline-block px-4 py-2 rounded-lg bg-[var(--color-ln-azul)] text-white text-sm"
          >
            Ver el perfil público
          </Link>
        </div>
      </div>
    );
  }

  // Gate 2: owner disabled the finder form.
  if (!pet.allowFinderFormWhenLost) {
    // Resolve disclosed contact info only when the owner opted in for each field.
    // Each network/DB call is individually gated so PII is never loaded unless
    // it will be shown — phone from the profile row only when disclosePhoneWhenLost,
    // email from the admin API only when discloseEmailWhenLost.
    let ownerPhone: string | null = null;
    let ownerEmail: string | null = null;

    if (pet.disclosePhoneWhenLost) {
      const [ownerRow] = await db
        .select({ phone: profiles.phone })
        .from(ownerships)
        .leftJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
        // role='owner' — an accepted temporary-caretaker grant opens a SECOND
        // active row on the same pet, so (pet_id, ended_at IS NULL) alone stopped
        // meaning "one row" and the limit(1) resolved by heap order. The titular's
        // disclosePhoneWhenLost is not consent to publish a CARETAKER's phone.
        .where(
          and(
            eq(ownerships.petId, pet.id),
            eq(ownerships.role, "owner"),
            isNull(ownerships.endedAt),
          ),
        )
        .orderBy(asc(ownerships.startedAt))
        .limit(1);
      ownerPhone = ownerRow?.phone ?? null;
    }

    if (pet.discloseEmailWhenLost) {
      const [ownerRow] = await db
        .select({ ownerUserId: ownerships.ownerUserId })
        .from(ownerships)
        // Same reason as the phone query above — this id is handed to
        // auth.admin.getUserById, so the wrong row publishes a caretaker's EMAIL.
        .where(
          and(
            eq(ownerships.petId, pet.id),
            eq(ownerships.role, "owner"),
            isNull(ownerships.endedAt),
          ),
        )
        .orderBy(asc(ownerships.startedAt))
        .limit(1);
      if (ownerRow?.ownerUserId) {
        try {
          const admin = createAdminClient();
          const { data } = await admin.auth.admin.getUserById(ownerRow.ownerUserId);
          ownerEmail = data?.user?.email ?? null;
        } catch (err) {
          // Non-fatal — render without email.
          reportError("public-encontre/owner-email", err, { publicToken });
        }
      }
    }

    return (
      // Landing shell (AppShell variant=landing) owns #main-content + min-height.
      <div className="min-h-screen bg-[var(--color-ln-paper)] px-4 py-10">
        <div className="mx-auto max-w-md space-y-5">
          <header className="space-y-1">
            <Link
              href={`/p/${publicToken}`}
              className="text-sm text-[var(--color-ln-ink)] underline underline-offset-4"
            >
              ← Volver al perfil
            </Link>
            <h1 className="text-xl font-semibold text-[var(--color-ln-ink)] mt-2">
              El dueño/a prefiere ser contactado/a directamente
            </h1>
            <p className="text-sm text-[var(--color-ln-mute)]">
              Para avisarle que encontraste a {pet.name}, comunicate por los medios que el dueño/a
              habilitó:
            </p>
          </header>

          {ownerPhone || ownerEmail ? (
            <ul className="space-y-3">
              {ownerPhone && (
                <li>
                  <a
                    href={`tel:${ownerPhone}`}
                    className="flex items-center gap-3 rounded-lg border border-[var(--color-ln-line)] px-4 py-3 text-sm font-medium text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)] transition-colors"
                  >
                    <Icon name="telefono" size="sm" decorative />
                    Llamar al {ownerPhone}
                  </a>
                </li>
              )}
              {ownerEmail && (
                <li>
                  <a
                    href={`mailto:${ownerEmail}`}
                    className="flex items-center gap-3 rounded-lg border border-[var(--color-ln-line)] px-4 py-3 text-sm font-medium text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)] transition-colors"
                  >
                    <Icon name="mail" size="sm" decorative />
                    Escribir a {ownerEmail}
                  </a>
                </li>
              )}
            </ul>
          ) : (
            <p className="text-sm text-[var(--color-ln-mute)]">
              El dueño/a no habilitó información de contacto pública. Mirá el perfil para ver si hay
              otro medio de contacto.
            </p>
          )}

          <Link
            href={`/p/${publicToken}`}
            className="block text-center text-sm text-[var(--color-ln-azul)] underline underline-offset-4"
          >
            Ver el perfil de {pet.name}
          </Link>
        </div>
      </div>
    );
  }

  // Happy path: pet is lost + allowFinderFormWhenLost.
  // Logged-in detection (banner only — NO form prefill, PO 2026-07-16): check
  // for a session without redirecting; resolve the display name so the
  // "¿No sos vos? Salí de la sesión" advisory can identify whose session it is.
  let loggedIn = false;
  let sessionDisplayName: string | null = null;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user?.id) {
      loggedIn = true;
      const [profile] = await db
        .select({ displayName: profiles.displayName })
        .from(profiles)
        .where(eq(profiles.id, user.id))
        .limit(1);
      sessionDisplayName = profile?.displayName ?? null;
    }
  } catch (err) {
    // Non-fatal — anonymous path.
    reportError("public-encontre/session", err, { publicToken });
  }

  // Resolve owner first name (for the header copy "X está esperando reencontrarse").
  // Gated on disclosePrefs — only fetch the name if the owner opted in, same as
  // the credential page (app/(public)/p/[publicToken]/page.tsx) and the cartel
  // page (app/(app)/mis-mascotas/[publicToken]/cartel/page.tsx).
  let ownerFirstName: string | null = null;

  if (pet.discloseFirstNameWhenLost) {
    const [ownerRow] = await db
      .select({ displayName: profiles.displayName })
      .from(ownerships)
      .innerJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
      // Same reason as the two queries above — the header names the TITULAR.
      .where(
        and(eq(ownerships.petId, pet.id), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
      )
      .orderBy(asc(ownerships.startedAt))
      .limit(1);

    ownerFirstName = ownerRow?.displayName ? ownerRow.displayName.trim().split(/\s+/)[0] : null;
  }

  return (
    // Landing shell (AppShell variant=landing) owns #main-content + min-height.
    <div className="min-h-screen bg-[var(--color-ln-warn-050)] px-4 py-6">
      <div className="mx-auto max-w-md space-y-5">
        <header className="space-y-2">
          <Link
            href={`/p/${publicToken}`}
            className="text-sm text-[var(--color-ln-ink)] underline underline-offset-4"
          >
            ← Volver al perfil
          </Link>

          {/* Pet mini-header: small photo + name */}
          <div className="flex items-center gap-3 pt-1">
            {photoUrl ? (
              <img
                src={photoUrl}
                alt={pet.name}
                className="w-14 h-14 rounded-xl object-cover ring-2 ring-white shadow"
              />
            ) : (
              <div className="w-14 h-14 rounded-xl bg-[var(--color-ln-stripe)] flex items-center justify-center text-2xl font-semibold text-[var(--color-ln-mute)] ring-2 ring-white shadow">
                {pet.name.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="text-xl font-semibold text-[var(--color-ln-ink)]">
                {foundPossessivePhrase(pet.sex)}: {pet.name}
              </h1>
              <p className="text-xs text-[var(--color-ln-mute)] mt-0.5">
                {ownerFirstName
                  ? `${ownerFirstName} está esperando reencontrarse con ${pet.name}.`
                  : `Su familia está esperando reencontrarse con ${pet.name}.`}
              </p>
            </div>
          </div>

          <p className="text-sm text-[var(--color-ln-mute)]">
            Completá el formulario y le avisamos al dueño/a al instante para que coordinen el
            encuentro.
          </p>
        </header>

        <section className="rounded-2xl bg-[var(--color-ln-card)] p-4">
          <FinderInPossessionForm
            publicToken={publicToken}
            petName={pet.name}
            biasProvince={pet.jurisdictionProvince}
            biasLocality={pet.jurisdictionLocality}
            loggedIn={loggedIn}
            sessionDisplayName={sessionDisplayName}
          />
        </section>
      </div>
    </div>
  );
}
