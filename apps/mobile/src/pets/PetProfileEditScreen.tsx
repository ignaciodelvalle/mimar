// EDITAR — the animal's data, by section, and who to call when something
// happens to it.
//
// SIX SECTIONS, EACH WITH ITS OWN GUARDAR (owner-pet-actions, PO plan
// 2026-10-01): Identidad, Salud y cuidados, Contactos, Qué muestra la credencial
// pública, Seguro, Origen — the web form's order, so a person who used one
// surface finds the other. The app's "Editar datos" could change three fields
// before this; it now reaches every field the web's does, through the same
// `updatePet` (`edit_profile`).
//
// THE SECTIONS ARE NOT COSMETIC, and they are authorized and recorded
// differently:
//
//   · IDENTIDAD and the four profile sections write the animal's own columns
//     through `edit_profile`, one section per call, and a real change appends
//     a `pet_profile_updated` to the ledger — a correction is itself an entry.
//   · CONTACTOS writes four override columns and appends nothing: a preference
//     of the person, not a fact about the pet, and the TITULAR's own vet and
//     phone, so this section can be refused while the others are offered.
//   · The SPECIES correction and the MUDANZA are their own acts with their own
//     events (FULL-LOCK, PO decision #40), drawn under Identidad.
//
// EVERY AFFORDANCE COMES FROM `capabilities`, NEVER FROM "is this my pet". The
// server sends a flag per rule and this screen renders the REASON in place of
// a form when one is false — see the view-model for the sentences.
//
// A SAVE RE-READS AND RE-SEEDS ITS OWN SECTION ONLY. The ack is not the new
// state (the server folds "pitbull" into "Pit Bull Terrier"), so every landed
// save re-reads; but on a screen with six Guardar buttons, re-seeding EVERY
// draft would throw away what somebody typed in another section and has not
// saved yet. `reseedDrafts` replaces the saved section and leaves the rest.
//
// `?seccion=` OPENS THE SCREEN ON A SECTION. The panel's "Contactos de
// emergencia" row lands here on Contactos (`editPetRoute(token, { seccion })`),
// which is what makes it a different door from "Editar datos" and not a
// duplicate.

import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { type LayoutChangeEvent, type ScrollView, StyleSheet, View } from "react-native";

import type { PetProfileEditV1 } from "@dim/contract/api";

import { apiFailureMessage } from "../api/client";
import { fetchPetProfileEdit, sendPetProfileCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Loading } from "../ui/components";
import { Callout, Screen, SecondaryButton, Title } from "../ui/kit";
import { type PetEditSection, movePetRoute } from "../ui/routes";
import { SPACE } from "../ui/theme";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import {
  ContactsSection,
  HealthSection,
  IdentitySection,
  InsuranceSection,
  type Notice,
  OriginSection,
  PublicCredentialSection,
} from "./PetProfileEditSections";
import {
  type CommandResult,
  type EditDrafts,
  type ProfileDrafts,
  type SaveGroup,
  editDraftsFrom,
  reseedDrafts,
  sameEditDrafts,
  savedLabel,
} from "./pet-profile-edit-view-model";

/**
 * One sentence per failure arm. No arm falls through to a generic shrug, and
 * none of them quotes anything the server sent.
 */
type ScreenState =
  | { phase: "loading" }
  | { phase: "ready"; view: PetProfileEditV1 }
  | { phase: "failed"; message: string };

export function PetProfileEditScreen({
  publicToken,
  initialSection = null,
}: {
  publicToken: string;
  /** The section a `?seccion=` named; `null` opens the screen at the top. */
  initialSection?: PetEditSection | null;
}) {
  const router = useRouter();
  const edit = usePetProfileEdit(publicToken);
  const sections = useSectionScroll(initialSection);

  // THE BACK GESTURE MAY NOT DISCARD AN EDIT (A2-alta-asentar-08). One question
  // for every section: somebody may have saved Seguro and still be holding an
  // unsaved allergy, and a guard that watched one section would let it go.
  useDraftDiscardGuard(edit.dirty);

  if (edit.state.phase === "failed") {
    return (
      <Screen>
        <Title>Editar datos</Title>
        <Callout tone="err">
          <Body>{edit.state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void edit.load()} />
      </Screen>
    );
  }
  if (edit.state.phase === "loading" || edit.drafts === null) {
    return <Loading label="Cargando los datos…" />;
  }

  const shared = {
    view: edit.state.view,
    drafts: edit.drafts,
    busy: edit.busy,
    notice: edit.notice,
    onSave: edit.save,
  };

  return (
    // `keyboardAvoiding` because every section is text inputs down a long
    // scroll — without it the keyboard covers the field being typed into.
    <Screen keyboardAvoiding scrollRef={sections.scrollRef}>
      <Title>Editar datos</Title>
      <View onLayout={sections.anchor("identidad")} style={styles.section}>
        <IdentitySection
          {...shared}
          onIdentity={(identity) => edit.patch({ identity })}
          onExtras={(extras) => edit.patchProfile("identityExtras", extras)}
          onSpecies={(species) => edit.patch({ species })}
          onMove={() => router.push(movePetRoute(publicToken))}
        />
      </View>
      <View onLayout={sections.anchor("salud")}>
        <HealthSection {...shared} onChange={(health) => edit.patchProfile("health", health)} />
      </View>
      <View onLayout={sections.anchor("contactos")}>
        <ContactsSection {...shared} onChange={(contacts) => edit.patch({ contacts })} />
      </View>
      <View onLayout={sections.anchor("credencial")}>
        <PublicCredentialSection
          {...shared}
          onChange={(publicCredential) => edit.patchProfile("publicCredential", publicCredential)}
        />
      </View>
      <View onLayout={sections.anchor("seguro")}>
        <InsuranceSection
          {...shared}
          onChange={(insurance) => edit.patchProfile("insurance", insurance)}
        />
      </View>
      <View onLayout={sections.anchor("origen")}>
        <OriginSection {...shared} onChange={(origin) => edit.patchProfile("origin", origin)} />
      </View>
    </Screen>
  );
}

/**
 * The read, the drafts and the saves — everything the screen does that is not
 * drawing it.
 *
 * THE BASELINE IS THE SERVER'S LAST ANSWER, captured with the drafts from the
 * same read (and the same instant, for the age): "dirty" means "differs from
 * what is stored", it goes back to clean when a save lands, and it cannot turn
 * dirty on its own at midnight.
 */
function usePetProfileEdit(publicToken: string) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [baseline, setBaseline] = useState<EditDrafts | null>(null);
  const [drafts, setDrafts] = useState<EditDrafts | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  /** Seed from a read: every draft (`null`), or only the group just saved. */
  const seed = useCallback((payload: PetProfileEditV1, group: SaveGroup | null) => {
    const fresh = editDraftsFrom(payload, new Date());
    setState({ phase: "ready", view: payload });
    setBaseline(fresh);
    setDrafts((current) =>
      group === null || current === null ? fresh : reseedDrafts(current, fresh, group),
    );
  }, []);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const result = await fetchPetProfileEdit(sessionPort, publicToken);
    if (result.outcome === "ok") {
      seed(result.payload, null);
      return;
    }
    setState({
      phase: "failed",
      message: apiFailureMessage(result) ?? "No pudimos abrir los datos de la mascota.",
    });
  }, [publicToken, seed]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(
    async (group: SaveGroup, built: CommandResult) => {
      if (!built.ok) {
        setNotice({ group, tone: "err", message: built.message });
        return;
      }
      setBusy(true);
      setNotice(null);
      const result = await sendPetProfileCommand(sessionPort, publicToken, built.input);
      if (result.outcome !== "ok") {
        setBusy(false);
        setNotice({
          group,
          tone: "err",
          message: apiFailureMessage(result) ?? "No pudimos guardar los cambios.",
        });
        return;
      }
      // D2 and D3 widened the ack into a union this screen never receives the
      // other arms of (the chapita and service-dog screens send those):
      // `"changed" in` narrows to the arms this screen does send.
      if (!("changed" in result.payload)) {
        setBusy(false);
        setNotice({ group, tone: "err", message: "La respuesta del servidor no se pudo leer." });
        return;
      }
      setNotice({
        group,
        tone: "ok",
        message: savedLabel(result.payload.command, result.payload.changed),
      });
      // The ack is deliberately NOT the new state — re-read, so the section
      // shows what the server stored rather than what this screen sent. A
      // re-read that fails leaves the screen as typed; the save itself landed.
      const reread = await fetchPetProfileEdit(sessionPort, publicToken);
      if (reread.outcome === "ok") seed(reread.payload, group);
      setBusy(false);
    },
    [publicToken, seed],
  );

  const save = useCallback(
    (group: SaveGroup, built: CommandResult) => {
      void send(group, built);
    },
    [send],
  );

  const patch = useCallback((next: Partial<EditDrafts>) => {
    setDrafts((current) => (current === null ? current : { ...current, ...next }));
  }, []);

  const patchProfile = useCallback(
    <K extends keyof ProfileDrafts>(key: K, value: ProfileDrafts[K]) => {
      setDrafts((current) =>
        current === null || current.profile === null
          ? current
          : { ...current, profile: { ...current.profile, [key]: value } },
      );
    },
    [],
  );

  const dirty = drafts !== null && baseline !== null && !sameEditDrafts(baseline, drafts);

  return { state, drafts, notice, busy, dirty, load, save, patch, patchProfile };
}

/** Breathing room above the section the screen opens on — `useScrollToError`'s margin. */
const SECTION_SCROLL_MARGIN = SPACE.lg;

/**
 * Scroll to the section a `?seccion=` named, ONCE, when it first lays out.
 *
 * `onLayout` AND NOT A MEASUREMENT AFTER THE FACT: each section is a direct
 * child of the scroll content, so the `y` its first layout reports is already
 * in the content coordinates `scrollTo` speaks, with everything above it laid
 * out in the same pass. ONCE, because a section above can grow later (the
 * breed list answering a query) and a reader who has started scrolling must not
 * be yanked back to where the link pointed.
 */
function useSectionScroll(target: PetEditSection | null) {
  const scrollRef = useRef<ScrollView>(null);
  const done = useRef(false);
  const anchor = useCallback(
    (section: PetEditSection) => (event: LayoutChangeEvent) => {
      if (done.current || section !== target) return;
      done.current = true;
      scrollRef.current?.scrollTo({
        y: Math.max(0, event.nativeEvent.layout.y - SECTION_SCROLL_MARGIN),
        animated: false,
      });
    },
    [target],
  );
  return { scrollRef, anchor };
}

const styles = StyleSheet.create({
  /** Identidad carries three cards (the form, the species, the mudanza) under one anchor. */
  section: { gap: SPACE.lg },
});
