"use client";

/**
 * SheetMounter — deep-link driven quick-capture sheets for the pet detail page.
 *
 * Opens the appropriate form Sheet based on `?sheet=<id>` URL state.
 * Closing removes the `sheet` (and `text`) params from the URL via router.replace.
 *
 * Supported sheet IDs:
 *   vacuna | peso | sintoma | medicacion | nota | anotar
 *   mostrar-tier2 | compartir-libreta | transferir-mascota
 *
 * NOTE: Full reminder pre-fill (initialVaccineName / sourceReminderId) is
 * intentionally omitted from the VaccinationForm sheet path. The full route
 * at /eventos/nuevo/vacuna/page.tsx does the reminder lookup — the sheet is
 * opt-in quick-capture only. The reminder-linked vaccination flow continues
 * to use the dedicated route.
 *
 * NOTE: SymptomForm accepts `freeText` and `onsetAt` prefill slots via searchParams.
 * These are forwarded from buildCaptureDeeplink when the symptom_observed intent fires.
 *
 * `anotar` (pet-document-redesign D1, ADR-5): hosts CaptureBox + the full
 * discoverability list (CaptureOptionsList) — the same content the /anotar
 * fallback page renders, now the PRIMARY in-profile entry point. Owner-only;
 * org viewers never reach this branch (no trigger renders for them — see
 * page.tsx action row + PetAnotarFooterCta).
 *
 * Router-hot-path fix: this component is always mounted by page.tsx
 * regardless of `?sheet=` (verified — page.tsx never gates it behind
 * `sp.sheet`), so open state simply reacts to useSearchParams(), which Next
 * updates reactively on both the SSR-provided initial URL AND on
 * pushSheetUrl()'s shallow window.history.pushState calls from every
 * trigger (PetActionRow, LibretaFace's EmergenciaBlock
 * link, MasSheet — see lib/ui/sheet-nav.ts). `close()` uses closeSheetNav
 * instead of router.replace so closing never touches the router either.
 */

import { TurnoAntirrabicaSheet } from "@/components/pet-profile/TurnoAntirrabicaSheet";
import { LnButton } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/VaulSheet";
import { buildCloseSheetUrl } from "@/lib/ui/sheet-helpers";
import { closeSheetNav, closeSheetNavWithFullReload } from "@/lib/ui/sheet-nav";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { foundParticiple, markLostActionLabel } from "@/lib/utils/format";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useActionState, useCallback } from "react";

import { CaptureBox } from "./anotar/CaptureBox";
import { CaptureOptionsList } from "./anotar/CaptureOptionsList";
import { MedicationStartForm } from "./eventos/nuevo/medicacion-inicio/MedicationStartForm";
import { NoteForm } from "./eventos/nuevo/nota/NoteForm";
import { WeightForm } from "./eventos/nuevo/peso/WeightForm";
import { SymptomForm } from "./eventos/nuevo/sintoma/SymptomForm";
import { VaccinationForm } from "./eventos/nuevo/vacuna/VaccinationForm";
import { MarkLostWizard } from "./perdida/MarkLostWizard";

import { createLibretaShareAction } from "@/app/actions/libreta-share";
import { setPetDisclosurePrefsAction } from "@/app/actions/lost-mode";
import { enableTier2PublicAction, revokeTier2PublicAction } from "@/app/actions/tier2-public";
import { PetForm } from "@/components/PetForm";
import {
  type DisclosurePrefs,
  LostDisclosureCard,
} from "@/components/pet-profile/LostDisclosureCard";
import type { Pet } from "@/db";
import type { PhysicalCredentialChannels } from "@/lib/domain/business-rules-defaults";
import {
  type EventFormState,
  createNoteAction,
  createSymptomObservedAction,
  setPetFoundAction,
  setPetLostAction,
} from "@/src/modules/events/actions";
import {
  createMedicationStartAction,
  createVaccinationAction,
  createWeightAction,
} from "@/src/modules/events/actions-medical";
import { updatePetAction } from "@/src/modules/pets/actions";

import type { EmergencyContactValues } from "@/components/pet-profile/EmergencyContactFields";
import { PhysicalTagInterestSheet } from "./_chapita/PhysicalTagInterestSheet";
import { EmergencyContactSheet } from "./_emergencia/EmergencyContactSheet";
import { MasSheet } from "./_more/MasSheet";
import { MergedShareSheet } from "./_share/MergedShareSheet";
import { TransferSenderForm } from "./_transfer/TransferSenderForm";

type MarkLostData = {
  // Disclosure prefs are no longer collected at mark time (lean audit
  // 2026-07-03 dedup) — LostDisclosureCard owns them; the mark applies the
  // pet's existing defaults server-side.
  petHasMicrochip: boolean;
  petHasTattoo: boolean;
  petColor: string | null;
  petDistinguishingFeatures: string | null;
  petJurisdictionProvince: string | null;
  petJurisdictionLocality: string | null;
};

type Props = {
  petToken: string;
  petName: string;
  /** Pet sex ('male' | 'female' | 'unknown') — flexes the mark-lost sheet
   * title and the lost share copy (ciclo-perdido sweep fix #2). */
  petSex: string | null;
  species: string;
  /** ISO string of pet.tier2PublicEnabledUntil — null when not set. */
  tier2PublicEnabledUntil: string | null;
  /** Whether the permanent "siempre" option is active (tier2PublicPermanent column). */
  tier2PublicPermanent: boolean;
  /** Data required by MarkLostForm. Null when pet is not active (already lost or deceased). */
  markLostData: MarkLostData | null;
  /** Data required by the editar-mascota sheet. Always set. */
  editPetData: {
    existingPet: Pet;
    existingPhotoUrl: string | null;
    /**
     * Jurisdiction-resolved PPP breed list (resolveBusinessRule for the pet's
     * jurisdiction) so the sheet's inline "raza peligrosa" warning flags a
     * breed a locality ADDED via the admin console — parity with the
     * standalone /editar page. Display-only.
     */
    pppBreedList: readonly string[];
  };
  /** Pet status — needed to gate the marcar-encontrada sheet. */
  petStatus: "active" | "lost" | "deceased";
  /** Two-face redesign (2026-07-01) — required by the "⋯ Más" sheet (MasSheet). */
  accessPath: "owner" | "org";
  ownershipRole: string | null;
  hasPendingReturnProposal: boolean;
  /**
   * physical-tag-interest state for the owner viewer (pet-document-redesign
   * ADR-17b). Null for org viewers / deceased pets — the chapita branch
   * denies those before this is ever read.
   */
  chapitaData: { interested: boolean; requestedAt: Date | null } | null;
  /**
   * Physical credential channel availability for the pet's jurisdiction
   * (admin-rules-console ADR-5/R3.5) — resolved via
   * resolvePhysicalCredentialChannels. Same null-gating as chapitaData.
   */
  physicalCredentialChannels: PhysicalCredentialChannels | null;
  /**
   * Current vet/emergency contact values for the `?sheet=emergencia` sheet
   * (pet-document-redesign ADR-13). Owner-only — null for org viewers, same
   * gating page.tsx already applies to `viewerContacts`.
   */
  emergencyContacts: EmergencyContactValues | null;
  /**
   * "Primeros pasos" star item (?sheet=privacidad) — lets the owner decide
   * lost-mode disclosure prefs BEFORE a crisis instead of only at mark-lost
   * time. Same legal-owner + non-deceased gate as emergencyContacts (null =
   * no entry point for this viewer/state).
   */
  disclosurePrefs: DisclosurePrefs | null;
  /** Owner first name for LostDisclosureCard's preview copy. */
  ownerFirstName: string;
  /**
   * KEY 2 of the two-key public-contact model — the active caretaker's display
   * name when they consented at invitation accept, null otherwise. Null hides
   * the sixth disclosure row (see LostDisclosureCard); a switch that cannot
   * change what the public sees is a lie in the shape of a control.
   */
  caretakerConsentName?: string | null;
  /**
   * A5 — a found-pet report on this pet also alerts the shelter it came out of.
   * Disclosed inside LostDisclosureCard; resolved server-side with the
   * notifier's own predicate (lib/infra/origin-shelter-alert.ts).
   */
  alertsOriginShelter: boolean;
  /**
   * QA A9 — whether the anotar catalog shows the "Check-in post-adopción"
   * entry. Resolved server-side by page.tsx via isPetAdoptedByUser (same
   * predicate the check-in page 404-gates on).
   */
  showCheckinOption: boolean;
  /**
   * Whether the anotar catalog shows the "Registrar embarazo" entry. Resolved
   * server-side by page.tsx via canStartPregnancy, off the `pets` row it
   * already holds — the same predicate the destination page enforces.
   */
  showPregnancyStartOption: boolean;
};

export function SheetMounter({
  petToken,
  petName,
  petSex,
  species,
  tier2PublicEnabledUntil,
  tier2PublicPermanent,
  markLostData,
  editPetData,
  petStatus,
  accessPath,
  ownershipRole,
  hasPendingReturnProposal,
  chapitaData,
  physicalCredentialChannels,
  emergencyContacts,
  disclosurePrefs,
  ownerFirstName,
  alertsOriginShelter,
  showCheckinOption,
  showPregnancyStartOption,
  caretakerConsentName = null,
}: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sheet = searchParams.get("sheet");
  const text = searchParams.get("text") ?? undefined;
  // Slot params forwarded by buildCaptureDeeplink when coming from CaptureBox / deeplinks.
  const kg = searchParams.get("kg") ?? undefined;
  const occurredAt = searchParams.get("occurredAt") ?? undefined;
  const notes = searchParams.get("notes") ?? undefined;
  // Symptom-specific prefill slots (symptom_observed registry entry).
  const freeText = searchParams.get("freeText") ?? undefined;
  const onsetAt = searchParams.get("onsetAt") ?? undefined;
  // anotar-specific prefill: forwarded event kind (e.g. from a notification CTA or
  // handoff, mirrors the `/anotar?kind=` fallback-page contract).
  const kind = searchParams.get("kind") ?? undefined;

  const close = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("text");
    closeSheetNav(buildCloseSheetUrl(pathname, params));
  }, [pathname, searchParams]);

  // EmergencyContactSheet's onSaved (not its "×"/cancel onClose, which stays
  // on the regular shallow `close` above): the save mutates
  // `profiles.emergency_*`, which LibretaFace's EmergenciaBlock renders
  // server-side from page.tsx's initial SSR output. A shallow close never
  // re-fetches that RSC tree, so the card kept the old phone until a hard
  // reload — see closeSheetNavWithFullReload's docblock for why
  // router.refresh() isn't a safe fix either (same silent-drop defect,
  // engram #621/#622).
  const closeAfterEmergencyContactSave = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("text");
    closeSheetNavWithFullReload(buildCloseSheetUrl(pathname, params));
  }, [pathname, searchParams]);

  if (sheet === "anotar") {
    // REQ-4.4: org viewers never get an Anotar entry point. No trigger
    // renders for them (action row / footer CTA), and this is the
    // defense-in-depth backstop for a hand-typed URL.
    // REQ-9.3: a deceased pet never accepts new events — same backstop.
    if (accessPath !== "owner" || petStatus === "deceased") return null;
    // No-flash routing (flow audit + code review 2026-07-03): a resolvable
    // intent (?kind=… or matcher-recognized ?text=…) is redirected to its
    // target form by the SERVER (page.tsx, before render) so nothing flashes
    // and no client router.replace can silently drop the hop. By the time we
    // mount here the intent is unresolvable — open the anotar sheet with the
    // "no reconocemos" UI.
    return (
      <Sheet id="anotar" title={`Anotar algo de ${petName}`} open onClose={close} size="lg">
        <div className="space-y-7">
          <CaptureBox
            petPublicToken={petToken}
            petName={petName}
            initialText={text}
            initialKind={kind}
            showCheckinOption={showCheckinOption}
          />
          <div className="flex items-center gap-3 text-xs text-[var(--color-ln-mute)]">
            <div className="h-px flex-1 bg-[var(--color-ln-stripe)]" />
            {/* Ver S2-F09 en CaptureBox: este bloque es el CATÁLOGO COMPLETO
                agrupado por categoría, no una repetición de los atajos. El
                conteo que decía acá se sacó al agregar una opción: un número en
                un comentario no falla cuando deja de ser cierto. */}
            <span>Todos los tipos de registro</span>
            <div className="h-px flex-1 bg-[var(--color-ln-stripe)]" />
          </div>
          <CaptureOptionsList
            petPublicToken={petToken}
            showCheckinOption={showCheckinOption}
            showPregnancyStartOption={showPregnancyStartOption}
          />
        </div>
      </Sheet>
    );
  }

  if (sheet === "vacuna") {
    const action = createVaccinationAction.bind(null, petToken);
    return (
      <Sheet id="vacuna" title="Registrar vacuna" open onClose={close}>
        <VaccinationForm
          action={action}
          species={species}
          defaults={{ occurredAt: null, notes: text ?? null }}
        />
      </Sheet>
    );
  }

  if (sheet === "peso") {
    const action = createWeightAction.bind(null, petToken);
    return (
      <Sheet id="peso" title="Registrar peso" open onClose={close}>
        <WeightForm
          action={action}
          defaults={{
            kg: kg ?? null,
            occurredAt: occurredAt ?? null,
            notes: notes ?? text ?? null,
          }}
        />
      </Sheet>
    );
  }

  if (sheet === "sintoma") {
    const action = createSymptomObservedAction.bind(null, petToken);
    return (
      <Sheet id="sintoma" title="Registrar síntoma" open onClose={close}>
        <SymptomForm
          action={action}
          petName={petName}
          defaults={{ freeText: freeText ?? null, onsetAt: onsetAt ?? null }}
        />
      </Sheet>
    );
  }

  if (sheet === "medicacion") {
    const action = createMedicationStartAction.bind(null, petToken);
    return (
      <Sheet id="medicacion" title="Inicio de medicación" open onClose={close}>
        <MedicationStartForm
          action={action}
          species={species}
          defaultNotes={notes ?? text}
          defaultOccurredAt={occurredAt}
        />
      </Sheet>
    );
  }

  if (sheet === "nota") {
    const action = createNoteAction.bind(null, petToken);
    return (
      <Sheet id="nota" title="Nota" open onClose={close}>
        <NoteForm
          action={action}
          defaults={{ text: text ?? null, occurredAt: occurredAt ?? null }}
        />
      </Sheet>
    );
  }

  if (sheet === "turno-antirrabica") {
    return (
      <Sheet id="turno-antirrabica" title="Programar antirrábica" open onClose={close}>
        <TurnoAntirrabicaSheet petToken={petToken} />
      </Sheet>
    );
  }

  // "compartir" — the merged share sheet (design ADR-7): public QR link +
  // expiring share link (formerly compartir-libreta) + Tier 2 medical view
  // toggle (formerly mostrar-tier2), fused into one affordance. The two old
  // sheet ids are kept below as deep-link ALIASES routing into this same
  // sheet — see the "Sheets map" table in design.md.
  if (sheet === "compartir" || sheet === "compartir-libreta" || sheet === "mostrar-tier2") {
    const now = new Date();
    const activeUntilDate = tier2PublicEnabledUntil ? new Date(tier2PublicEnabledUntil) : null;
    const isActive = tier2PublicPermanent || (!!activeUntilDate && activeUntilDate > now);
    const enable = enableTier2PublicAction.bind(null, petToken);
    const revoke = revokeTier2PublicAction.bind(null, petToken);
    // Wrap the action so the sheet only supplies expiresInDays + label;
    // petPublicToken is captured from the outer scope.
    const shareAction = (input: { expiresInDays: number | null; label: string | null }) =>
      createLibretaShareAction({ petPublicToken: petToken, ...input });
    return (
      <Sheet id="compartir" title="Compartir" open onClose={close}>
        <MergedShareSheet
          petPublicToken={petToken}
          petName={petName}
          petSex={petSex}
          createShareAction={shareAction}
          tier2={{
            isActive,
            isPermanent: tier2PublicPermanent,
            activeUntil: isActive && !tier2PublicPermanent ? activeUntilDate : null,
            enableAction: enable,
            revokeAction: revoke,
          }}
          isOwner={accessPath === "owner"}
          isLost={petStatus === "lost"}
        />
      </Sheet>
    );
  }

  if (sheet === "chapita") {
    // REQ-11.2/REQ-9.3: owner-only, never for a deceased pet (ordering a
    // physical tag for a deceased pet is nonsensical) — defense-in-depth
    // backstop for a hand-typed URL, same pattern as the anotar branch.
    if (accessPath !== "owner" || petStatus === "deceased" || !chapitaData) return null;
    return (
      <Sheet id="chapita" title="Chapa física" open onClose={close}>
        <PhysicalTagInterestSheet
          petPublicToken={petToken}
          petName={petName}
          initialInterested={chapitaData.interested}
          initialRequestedAt={chapitaData.requestedAt}
          channels={physicalCredentialChannels}
        />
      </Sheet>
    );
  }

  if (sheet === "emergencia") {
    // ADR-13/REQ-9 (Phase 5): owner-only, same shape as the chapita branch's
    // defense-in-depth guard for a hand-typed URL.
    if (accessPath !== "owner" || !emergencyContacts) return null;
    return (
      <Sheet id="emergencia" title="Contactos de emergencia" open onClose={close}>
        <EmergencyContactSheet
          petPublicToken={petToken}
          initialValues={emergencyContacts}
          onSaved={closeAfterEmergencyContactSave}
        />
      </Sheet>
    );
  }

  if (sheet === "privacidad") {
    // "Primeros pasos" star item — same defense-in-depth backstop pattern as
    // the chapita/emergencia branches: disclosurePrefs is null unless this
    // viewer is the legal owner of an active pet, so a hand-typed URL from
    // anyone else renders nothing.
    if (accessPath !== "owner" || petStatus === "deceased" || !disclosurePrefs) return null;
    const toggleAction = setPetDisclosurePrefsAction.bind(null, petToken);
    return (
      <Sheet id="privacidad" title="Qué se muestra si se pierde" open onClose={close}>
        <LostDisclosureCard
          prefs={disclosurePrefs}
          toggleAction={toggleAction}
          publicHref={`/p/${petToken}`}
          ownerFirstName={ownerFirstName}
          alertsOriginShelter={alertsOriginShelter}
          caretakerConsentName={caretakerConsentName}
        />
      </Sheet>
    );
  }

  if (sheet === "mas") {
    return (
      <Sheet id="mas" title="Más" open onClose={close}>
        <MasSheet
          pet={{ species, status: petStatus, publicToken: petToken }}
          accessPath={accessPath}
          ownershipRole={ownershipRole}
          hasPendingReturnProposal={hasPendingReturnProposal}
        />
      </Sheet>
    );
  }

  if (sheet === "transferir-mascota") {
    return (
      <Sheet id="transferir-mascota" title="Transferir mascota" open onClose={close}>
        <TransferStub petName={petName} petToken={petToken} />
      </Sheet>
    );
  }

  if (sheet === "marcar-perdida") {
    // RA-2 F8 — same treatment the sibling marcar-encontrada sheet already got
    // (WP-6, below). `markLostData` is null whenever the pet is not "active"
    // (page.tsx builds it only for active pets), and ?sheet=marcar-perdida is
    // reachable on any pet: the Anotar capture list renders "Marcar como
    // perdida" unconditionally (anotar/handoff.ts), and free text ("se escapó")
    // routes here too. Returning null left an owner mid-crisis staring at their
    // own profile with no sheet and no explanation.
    if (!markLostData) {
      return (
        <Sheet
          id="marcar-perdida"
          title={markLostActionLabel(petSex)}
          open
          onClose={close}
          side="right"
          size="md"
        >
          <MarkLostNotApplicableNotice
            petName={petName}
            petSex={petSex}
            petToken={petToken}
            petStatus={petStatus}
            onClose={close}
          />
        </Sheet>
      );
    }
    const action = setPetLostAction.bind(null, petToken);
    return (
      <Sheet
        id="marcar-perdida"
        title={markLostActionLabel(petSex)}
        open
        onClose={close}
        side="right"
        size="lg"
      >
        <MarkLostWizard
          action={action}
          petName={petName}
          petSex={petSex}
          petPublicToken={petToken}
          petHasMicrochip={markLostData.petHasMicrochip}
          petHasTattoo={markLostData.petHasTattoo}
          petColor={markLostData.petColor}
          petDistinguishingFeatures={markLostData.petDistinguishingFeatures}
          petJurisdictionProvince={markLostData.petJurisdictionProvince}
          petJurisdictionLocality={markLostData.petJurisdictionLocality}
        />
      </Sheet>
    );
  }

  if (sheet === "editar-mascota") {
    const action = updatePetAction.bind(null, petToken);
    return (
      <Sheet
        id="editar-mascota"
        title={`Editar ${petName}`}
        open
        onClose={close}
        side="right"
        size="lg"
      >
        <PetForm
          action={action}
          existingPet={editPetData.existingPet}
          existingPhotoUrl={editPetData.existingPhotoUrl}
          pppBreedList={editPetData.pppBreedList}
        />
      </Sheet>
    );
  }

  if (sheet === "marcar-encontrada") {
    // WP-6: instead of returning null (silent no-op) when the pet is not lost,
    // render a lean friendly message so the user understands why the flow does
    // not apply and can navigate back to the profile.
    if (petStatus !== "lost") {
      return (
        <Sheet
          id="marcar-encontrada"
          title={`Marcar como ${foundParticiple(petSex)}`}
          open
          onClose={close}
          side="right"
          size="md"
        >
          <PetNotLostNotice petName={petName} petSex={petSex} petToken={petToken} onClose={close} />
        </Sheet>
      );
    }
    const action = setPetFoundAction.bind(null, petToken);
    return (
      <Sheet
        id="marcar-encontrada"
        title={`Marcar como ${foundParticiple(petSex)}`}
        open
        onClose={close}
        side="right"
        size="md"
      >
        <MarkFoundConfirmation action={action} petName={petName} petSex={petSex} onCancel={close} />
      </Sheet>
    );
  }

  // Unknown or absent sheet param — render nothing.
  return null;
}

// ---------------------------------------------------------------------------
// MarkFoundConfirmation — inline confirmation form for the marcar-encontrada sheet
// ---------------------------------------------------------------------------

function MarkFoundConfirmation({
  action,
  petName,
  petSex,
  onCancel,
}: {
  action: (previous: EventFormState, formData: FormData) => Promise<EventFormState>;
  petName: string;
  petSex: string | null;
  onCancel: () => void;
}) {
  // N3 redirect contract: setPetFoundAction returns `redirectTo` on success
  // and this form performs the full document navigation (see
  // lib/ui/use-action-redirect.ts) — which also closes this sheet by loading
  // the profile URL without the ?sheet= param.
  const [state, formAction, isPending] = useActionState(action, { error: null });
  useActionRedirect(state.redirectTo, state);

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-ln-ink-2)]">
        {/* Sin pronombre ni adjetivo fijo: "marcarla como perdida" le hablaba en
            femenino a cualquier animal. El participio sale de petSex. */}
        Vas a marcar a <strong>{petName}</strong> como {foundParticiple(petSex)}. La credencial
        pública vuelve al modo identidad básica (Tier 0). Si hace falta, podés volver a activar el
        modo perdido.
      </p>
      {state.error && (
        <p role="alert" className="text-sm text-[var(--color-ln-err)]">
          {state.error}
        </p>
      )}
      <form action={formAction} className="flex gap-2">
        <LnButton type="submit" variant="ok" disabled={isPending}>
          {isPending ? "Guardando…" : `Marcar como ${foundParticiple(petSex)}`}
        </LnButton>
        <LnButton type="button" variant="ghost" onClick={onCancel} disabled={isPending}>
          Cancelar
        </LnButton>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PetNotLostNotice — shown when marcar-encontrada is triggered but the pet
// is not currently marked as lost (WP-6 no-op fix).
// ---------------------------------------------------------------------------

function PetNotLostNotice({
  petName,
  petSex,
  petToken,
  onClose,
}: {
  petName: string;
  petSex: string | null;
  petToken: string;
  onClose: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-ln-ink-2)]">
        {/* e2e/demo/_helpers.ts (ensurePetFound) reconoce esta cara del sheet por
            "no figura en modo perdido": cambiar la frase es cambiar ese regex. */}
        <strong>{petName}</strong> no figura en modo perdido, así que no hay nada que marcar como{" "}
        {foundParticiple(petSex)}.
      </p>
      <div className="flex gap-2">
        <LnButton type="button" variant="ghost" onClick={onClose}>
          Volver al perfil
        </LnButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarkLostNotApplicableNotice — shown when marcar-perdida is triggered but the
// pet is not "active" (RA-2 F8). Mirrors PetNotLostNotice above: the flow does
// not apply, so say why and offer the move that DOES apply instead of dropping
// the owner on a blank profile mid-crisis.
// ---------------------------------------------------------------------------

function MarkLostNotApplicableNotice({
  petName,
  petSex,
  petToken,
  petStatus,
  onClose,
}: {
  petName: string;
  petSex: string | null;
  petToken: string;
  petStatus: "active" | "lost" | "deceased";
  onClose: () => void;
}) {
  const alreadyLost = petStatus === "lost";
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-ln-ink-2)]">
        {alreadyLost ? (
          <>
            <strong>{petName}</strong> ya está en modo perdido. Su aviso está publicado y visible
            para quien escanee su credencial, así que no hace falta volver a activarlo.
          </>
        ) : (
          <>
            <strong>{petName}</strong> tiene registrado su fallecimiento, así que no se puede
            activar el modo perdido. Si es un error, corregí su estado desde el perfil.
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {alreadyLost && (
          <Link href={`/mis-mascotas/${petToken}?sheet=marcar-encontrada`}>
            <LnButton type="button" variant="primary">
              Ya apareció — marcar como {foundParticiple(petSex)}
            </LnButton>
          </Link>
        )}
        <LnButton type="button" variant="ghost" onClick={onClose}>
          Volver al perfil
        </LnButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TransferStub — owner→owner handshake form (P3-2)
// ---------------------------------------------------------------------------

function TransferStub({ petName, petToken }: { petName: string; petToken: string }) {
  return <TransferSenderForm petName={petName} petToken={petToken} />;
}
