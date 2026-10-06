// The FRONT face of the pet document — what the person responsible for the
// animal sees. Composition (PO 2026-10-05, native):
//   centred photo (pokes into the band) → name / situation / facts →
//   Cumplimiento → Avisos.
//
// THE QR LEFT THIS FACE. The bright public credential lives on
// `CredentialScreen` (Compartir / the public route), with keep-awake + max
// brightness. Putting a second QR on the document duplicated that door and
// stole the centre column on a phone-width card.
//
// THE CARD CARRIES NO ACTIONS since owner-pet-actions (PO, 2026-10-01). The
// pill row moved BELOW the card into `OwnerActionPanel`. The photo frame stays
// on the document as the door to the photo screen.
//
// THE ISSUING FOOT LEFT TOO (PO annotate 2026-10-05): "Libreta Sanitaria ·
// place" and "Consultada el …" repeated the band, the locality chip and
// Cumplimiento.
//
// THIS IS NOT THE PUBLIC CREDENTIAL, AND IT DOES NOT REPLACE IT.
//
// EVERY SECTION FAILS ON ITS OWN. The payload wraps each one, and
// `unavailable` means the server could not read it — NOT that it is empty.
// "No hay recordatorios activos" is a fact; "No se pudo leer esta sección" is
// a different fact; and a section that rendered as an empty view would be
// telling the owner the first one while the server meant the second.

import { useRouter } from "expo-router";
import { useState } from "react";
import { Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import type { OwnerPetIdentitySection, OwnerPetObligationCardV1 } from "@dim/contract/api";
import { PET_ACTION_COPY } from "@dim/contract/reference";

import { Icon } from "../ui/Icon";
import { Body, Card, Row, Unavailable } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, LinkText, SecondaryButton, pressedOpacity } from "../ui/kit";
import { caseRoute, recordEventRoute } from "../ui/routes";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";
import {
  BAND_MAX_FONT_SCALE,
  FaceDivider,
  FaceSection,
  IDENTITY_POKE_OUT,
  situationChipSkin,
  situationPillStyles,
} from "./DocumentChromeNative";
import { PHOTO_MOUNT } from "./chrome-visual";
import {
  type OwnerFaceView,
  type OwnerPanelView,
  type PanelTarget,
  type SectionView,
  alertHeadline,
  alertTone,
  caretakerBannerLines,
  caseLine,
  casesLine,
  complianceStampLabel,
  complianceSummaryLabel,
  isAttestationDoorCard,
  rehomeBannerLine,
  reminderDueLabel,
  transitBannerLine,
  truncationNote,
} from "./owner-face-view-model";

/** Photo mount size — web phone `.pc-photo-mount` (116). Tunable in chrome-visual. */
export const PHOTO_SIZE = PHOTO_MOUNT.size;

// ---------------------------------------------------------------------------
// The face
// ---------------------------------------------------------------------------

export function OwnerCredentialFace({
  view,
  panel,
}: {
  view: OwnerFaceView;
  /**
   * The panel below the card, COMPUTED ONCE BY THE SCREEN AND HANDED TO BOTH.
   * The face reads the two doors that stay on the document from it — the
   * attestation on the compliance card and the photo frame — so the card and
   * the panel cannot disagree about what this viewer may do.
   */
  panel: OwnerPanelView;
}) {
  return (
    <>
      <FaceSection>
        <IdentityRow view={view} photoTarget={panel.photoTarget} />
      </FaceSection>

      {/* ESTADO's unavailable arm. When the read WORKS the state's text lives
          exclusively in the band chip (the single state authority, per the
          web's PO decision 2026-07-16) — repeating it here would be the
          "estado repetido varias veces" the PO already flagged once. A FAILED
          read still says so: no chip is what "al día" looks like, and the two
          must never look alike. */}
      {view.status.state === "unavailable" ? (
        <FaceSection>
          <Unavailable title="Estado" message={view.status.message} />
        </FaceSection>
      ) : null}

      {/* CUMPLIMIENTO --------------------------------------------------- */}
      <FaceDivider icon="shield" label="Cumplimiento" />
      <FaceSection>
        {view.compliance.state === "unavailable" ? (
          <Unavailable title="Cumplimiento" message={view.compliance.message} />
        ) : (
          <View style={styles.stack}>
            <Text style={styles.stamp}>{complianceStampLabel(view.compliance.data)}</Text>
            <Body>{complianceSummaryLabel(view.compliance.data)}</Body>
            {view.compliance.data.cards.map((card) => (
              <ComplianceCardRow
                key={card.key}
                card={card}
                attestationDoor={panel.attestationDoor}
                publicToken={view.publicToken}
              />
            ))}
          </View>
        )}
      </FaceSection>

      {/* AVISOS ---------------------------------------------------------- */}
      {/* Already ranked by the server; a client that reorders this has
          reimplemented a product decision it cannot see the reasons for.
          An EMPTY strip renders no section at all — the web's caller passes
          null and no divider appears — while a FAILED read renders its
          refusal. Empty and unavailable must never look alike. */}
      {view.alerts.state === "unavailable" ? (
        <>
          <FaceDivider icon="alert" label="Avisos" />
          <FaceSection>
            <Unavailable title="Avisos" message={view.alerts.message} />
          </FaceSection>
        </>
      ) : view.alerts.data.items.length > 0 ? (
        <>
          <FaceDivider icon="alert" label="Avisos" />
          <FaceSection>
            <View style={styles.stack}>
              {view.alerts.data.items.map((alert) => (
                <Callout key={alert.id} tone={alertTone(alert)}>
                  <Text style={styles.calloutBody}>{alertHeadline(alert)}</Text>
                </Callout>
              ))}
            </View>
          </FaceSection>
        </>
      ) : null}
    </>
  );
}

/**
 * One obligation card — its state, and the door out of it when there is one.
 *
 * THE ONE DOOR TODAY IS THE PPP ATTESTATION, and this is where the code that
 * writes it always said it would be: the contract's own `dangerousBreedAttestation`
 * docblock reads "REACHED FROM THE COMPLIANCE CARD, NOT THE PICKER … the app's
 * job is to offer the door only where the card reads 'Atestación requerida'",
 * and `WRITABLE_KINDS` repeats it ("from the compliance card that reads
 * 'Atestación requerida'"). Until 2026-09-10 the form existed, the contract
 * accepted it, and nothing in this app navigated to it.
 *
 * IT IS ALSO WHERE THE WEB PUTS IT. `ComplianceObligationsPanel.tsx` draws a
 * "Registrar atestación" link inside the ppp card, under the same condition —
 * "surfaced HERE (the canonical obligation card) instead of a duplicate row on
 * the credential face". The two surfaces name the act with the same three words
 * and reach it from the same place.
 */
function ComplianceCardRow({
  card,
  attestationDoor,
  publicToken,
}: {
  card: OwnerPetObligationCardV1;
  /** The catalogue's answer to "may this viewer file one for this animal". */
  attestationDoor: boolean;
  publicToken: string;
}) {
  const router = useRouter();
  return (
    <>
      <Row label={card.label} value={card.state} />
      {/* THE DATUM, which this face used to drop on the floor.

          `detail` is the contract's own "es-AR secondary line — date, provider,
          chip number", and until now nothing on the phone rendered it. That is
          not the same omission as the web's: over there the PILL carries the
          datum for the two cards that have one (`StatusBadge` appends
          "· HASTA 14/01/2027" to a current rabies stamp and shows the chip
          number itself on a verified microchip), which is exactly why the web
          suppresses `detail` for those two and prints it for everything else.

          This row's value is the BARE `card.state`. It does no such
          enrichment. So on the phone the date, the provider and the chip number
          appeared in NEITHER place — the owner read "Microchip · Registrado"
          with the number nowhere on the screen, and "Vacuna antirrábica ·
          Vigente" with no until-when. A compliance card that names an
          obligation and hides the fact that satisfies it is worse than quiet:
          it looks complete.

          Printed unconditionally, and that is correct HERE precisely because
          the value beside it never repeats it. The day this row starts
          enriching its value, this needs the web's suppression rule with it. */}
      {card.detail ? <Text style={styles.complianceDetail}>{card.detail}</Text> : null}
      {isAttestationDoorCard(card, attestationDoor) ? (
        <SecondaryButton
          label="Registrar atestación"
          accessibilityHint="Declarar la mascota ante el registro de perros potencialmente peligrosos que exige tu jurisdicción."
          onPress={() =>
            router.push(recordEventRoute(publicToken, { kind: "dangerous_breed_attestation" }))
          }
        />
      ) : null}
    </>
  );
}

/**
 * The issuing foot used to close the front face ("Libreta Sanitaria · place"
 * + "Consultada el …"). Removed 2026-10-05 (PO annotate): both lines repeated
 * what the band, the Belgrano chip and Cumplimiento already say, and the
 * consult date is envelope freshness, not a document fact the owner needs.
 */

// ---------------------------------------------------------------------------
// Identity row
// ---------------------------------------------------------------------------

/**
 * Identity block: centred photo poking into the band, then name + facts full
 * width underneath (PO 2026-10-05). No QR on this face — Compartir opens the
 * bright public credential. When `rightCell === "ping"`, a compact last-seen
 * mark sits with the facts (not a second mount).
 */
function IdentityRow({
  view,
  photoTarget,
}: {
  view: OwnerFaceView;
  /** The photo frame's door, from the panel; `null` = the frame is a picture only. */
  photoTarget: PanelTarget | null;
}) {
  const status = view.status.state === "ok" ? view.status.data : null;
  const showPing = status?.rightCell === "ping";
  const memorial =
    status?.memorial?.birthYear && status.memorial.deathYear
      ? `En memoria · ${status.memorial.birthYear}–${status.memorial.deathYear}`
      : status?.memorial
        ? "En memoria"
        : null;
  const situationSkin = status?.situation ? situationChipSkin(status.situation.key) : null;

  if (view.identity.state === "unavailable") {
    return (
      <View style={styles.idWrap}>
        <Unavailable title="Identidad" message={view.identity.message} />
      </View>
    );
  }

  // Locality only in the hero chips. "Microchip verificado" used to sit here
  // AND again under Cumplimiento — PO annotate 2026-10-05 keeps the obligation
  // card as the one place that names the chip.
  const placeTags = view.identity.data.tags.filter((tag) => tag.key === "loc");

  return (
    <View style={styles.idWrap}>
      <View style={styles.photoStage}>
        <PhotoFrame identity={view.identity.data} target={photoTarget} />
      </View>

      <View style={styles.idFacts}>
        <Text style={styles.petName}>{view.identity.data.name}</Text>
        {status?.situation && situationSkin ? (
          <View
            accessibilityRole={status.situation.key === "perdida" ? "alert" : undefined}
            style={[
              situationPillStyles.pill,
              {
                backgroundColor: situationSkin.backgroundColor,
                borderColor: situationSkin.borderColor,
              },
            ]}
          >
            <Icon name={status.situation.icon} size="sm" color={situationSkin.color} />
            <Text
              maxFontSizeMultiplier={BAND_MAX_FONT_SCALE}
              style={[situationPillStyles.text, { color: situationSkin.color }]}
            >
              {status.situation.label}
            </Text>
          </View>
        ) : null}
        {memorial ? <Text style={styles.memorial}>{memorial}</Text> : null}
        {showPing ? <PingBadge /> : null}
        {view.identity.data.breedLine ? <Body>{view.identity.data.breedLine}</Body> : null}
        {placeTags.length > 0 ? (
          <View style={styles.chipRow}>
            {placeTags.map((tag) => (
              <View key={tag.key} style={styles.chip}>
                <Icon name="map-pin" size="sm" color={COLORS.inkSoft} />
                <Text style={styles.chipText}>{tag.label}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Compact last-seen mark when the server resolved the right cell to a ping. */
function PingBadge() {
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="Último lugar conocido"
      style={styles.pingBadge}
    >
      <View style={styles.ping}>
        <View style={styles.pingGrid} />
        <View style={styles.pingRing} />
        <View style={styles.pingDot} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// The photo frame
// ---------------------------------------------------------------------------

/**
 * The photo frame — and, since owner-pet-actions, the door to the photo screen.
 *
 * A FIRST PHOTO USED TO TAKE FOUR TAPS (Más, "Foto de la mascota", then the
 * picker) while the frame itself drew a paw and did nothing, though it is the
 * one place on the screen a person looks when the picture is missing or wrong.
 * Now the frame IS the door: empty, it says "Agregar foto"; with a photo, a
 * small pencil says it can be changed.
 *
 * THE SAME GATE AS THE FOTO ROW, BY CONSTRUCTION. `target` is the panel's own
 * `photoTarget` — the Foto row's destination — so the frame and the row cannot
 * disagree: any person-path holder (a caretaker photographing the animal in
 * their care included, as `titular-only.ts` allows), and nobody on the
 * organization path, whose frame stays a picture.
 *
 * A PHOTO THAT WOULD NOT LOAD IS NAMED, NOT BLANK (S-1 / VT-2). RN's <Image>
 * draws nothing on a failed load, and a blank frame reads as "this animal has
 * no photo" — a claim about the record, made by a ten-second network failure.
 * Tapping it still offers to CHANGE the photo, because the record has one.
 */
function PhotoFrame({
  identity,
  target,
}: {
  identity: OwnerPetIdentitySection;
  target: PanelTarget | null;
}) {
  const router = useRouter();
  const [photoFailed, setPhotoFailed] = useState(false);
  const recordHasPhoto = Boolean(identity.photoUrl);
  const showImage = recordHasPhoto && !photoFailed;

  const picture =
    showImage && identity.photoUrl ? (
      <Image
        source={{ uri: identity.photoUrl }}
        style={styles.photoImage}
        accessibilityIgnoresInvertColors
        accessible
        accessibilityLabel={`Foto de ${identity.name}`}
        onError={() => setPhotoFailed(true)}
      />
    ) : (
      <View style={styles.photoEmpty}>
        <Icon name="paw" size="lg" color={COLORS.inkFaint} />
        {photoFailed ? <Text style={styles.photoFailed}>Foto no disponible</Text> : null}
        {!recordHasPhoto && target !== null ? (
          <Text style={styles.photoAdd}>Agregar foto</Text>
        ) : null}
      </View>
    );

  const mount = (
    <View style={styles.photoMount}>
      <View style={styles.photo}>{picture}</View>
    </View>
  );

  if (target === null) return mount;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        recordHasPhoto
          ? `Cambiar la foto de ${identity.name}`
          : `Agregar una foto de ${identity.name}`
      }
      accessibilityHint={PET_ACTION_COPY.photo.hint}
      onPress={() => router.push(target)}
      style={(state) => [pressedOpacity(state)]}
    >
      <View style={styles.photoMount}>
        <View style={styles.photo}>
          {picture}
          {showImage ? (
            <View style={styles.photoBadge}>
              <Icon name="edit" size="sm" color={COLORS.accent} />
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// The sections the document does not carry
// ---------------------------------------------------------------------------

/**
 * Renders a section, its refusal, or nothing at all. The three are never the
 * same view, and the distinction between the last two is the whole point.
 *
 * A REFUSAL ALWAYS RENDERS. `unavailable` means the server could not answer,
 * and a gap where an answer should be reads as "nothing to report" — the one
 * thing it does not mean. That arm is untouched.
 *
 * AN EMPTY SECTION RENDERS NOTHING. This is the rule the face above already
 * follows for the Avisos strip ("empty strip → renders nothing", AGENTS.md §6)
 * and that this block used to contradict twelve lines later: every section
 * rendered a titled Card unconditionally, so a healthy animal's credential was
 * followed by a column of identical boxes each announcing an absence — "No hay
 * recordatorios activos.", "No está preñada.", "No tiene trámites abiertos."
 * Four sentences saying nothing is wrong, drawn with the same weight as the
 * document above them.
 *
 * `isEmpty` is per-section and required to be explicit because emptiness is not
 * a property of the wrapper: an empty list, a null pregnancy and a zero case
 * count are three different shapes. A section that omits it always renders,
 * which is the safe default — a new section cannot vanish by forgetting.
 */
function Section<T>({
  view,
  title,
  isEmpty,
  children,
}: {
  view: SectionView<T>;
  title: string;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => React.ReactNode;
}) {
  if (view.state === "unavailable") {
    return <Unavailable title={title} message={view.message} />;
  }
  if (isEmpty?.(view.data) === true) {
    return null;
  }
  return <Card title={title}>{children(view.data)}</Card>;
}

/**
 * THE REMINDERS CARD — a list, and since 2026-09-16 only a list.
 *
 * IT USED TO CARRY THE DOOR, and that is why it was the one section exempt
 * from the hide-when-empty rule its siblings follow: this app's writes each
 * live on a route of their own, both reminder operations live on `/vacunas`,
 * and this card held the only button that went there. An empty list of
 * reminders is exactly the moment to schedule one, so the card could not
 * vanish without taking the affordance with it.
 *
 * THE DOOR MOVED INTO THE ⋯ Más SHEET (PO decision 2026-09-16), which dissolves
 * the exemption rather than arguing with it. The PO's report was about weight:
 * a healthy animal's credential was still followed by a titled box announcing
 * an absence, which is the exact shape the Avisos strip rule exists to prevent
 * (AGENTS.md §6, "empty strip → renders nothing"). Más is also where somebody
 * already looks for an action that is not one of the four on the face, so the
 * door is more findable there than it was under a card about nothing. Since
 * owner-pet-actions the door is the "Recordatorios de vacunas" row of the
 * panel's SALUD group, with no sheet to open first.
 *
 * WHAT DOES NOT CHANGE: the `unavailable` arm still renders. A read that
 * failed says nothing about whether reminders exist, and a gap where an answer
 * should be reads as "nothing to report" — the one thing it does not mean.
 * That is now the only reason this component is not a plain `Section`.
 */
function RemindersCard({ view }: { view: OwnerFaceView["reminders"] }) {
  if (view.state === "unavailable") {
    return <Unavailable title="Recordatorios" message={view.message} />;
  }

  const reminders = view.data;
  // Nothing scheduled renders NOTHING. The two empty lines this used to draw
  // (REMINDERS_EMPTY_LINE / REMINDERS_EMPTY_HINT) existed to give the door a
  // card to sit in; with the door in the panel they would be a titled box whose
  // only content is the news that there is no news.
  if (reminders.items.length === 0) return null;

  const note = truncationNote(reminders.items.length, reminders.total, "recordatorios");
  return (
    <Card title="Recordatorios">
      <View style={styles.stack}>
        {reminders.items.map((reminder) => (
          <Row
            key={reminder.reminderId}
            label={reminder.title}
            value={reminderDueLabel(reminder.daysUntilDue)}
          />
        ))}
        {/* A list that shows some of what exists must SAY so. */}
        {note ? <Body>{note}</Body> : null}
      </View>
    </Card>
  );
}

/**
 * Everything the payload carries that the web's credential sheet does NOT
 * print on the document: reminders, arrangements, open cases, pregnancy, the
 * owner's other pets. On the web these live in other surfaces (reminder rows,
 * the ⋯ Más sheets, the carousel above the card); this app has no such
 * surfaces yet, and DROPPING a section the server read for us would be the
 * quiet data loss this file's honesty rules exist against. So they render as
 * plain cards BELOW the document — app content, not credential content, the
 * same separation the web draws ("el carousel lo quiero FUERA de la
 * credencial"). Since owner-pet-actions they sit INSIDE the action panel,
 * between its primary row and its groups (`OwnerActionPanel`'s `children`).
 */
export function OwnerExtraSections({ view }: { view: OwnerFaceView }) {
  const router = useRouter();
  return (
    <>
      {/* REMINDERS ------------------------------------------------------- */}
      <RemindersCard view={view.reminders} />

      {/* THE BANNERS ------------------------------------------------------ */}
      {/* The empty test here is NOT symmetric with the others, and the
          asymmetry is the information. For the TITULAR, no arrangements is an
          empty state and the section disappears like the rest. For a caretaker
          or a foster it is a PERMISSION BOUNDARY — they see nothing because
          arrangements are the titular's to make, not because none exist — and
          "Solo el titular ve los arreglos" is the sentence that stops an
          unexplained gap from reading as a bug. Hiding that would delete an
          answer, which is the same mistake as hiding a refusal. */}
      <Section
        view={view.banners}
        title="Arreglos"
        isEmpty={(banners) =>
          view.isTitular &&
          caretakerBannerLines(banners).length === 0 &&
          !rehomeBannerLine(banners) &&
          !transitBannerLine(banners)
        }
      >
        {(banners) => {
          const caretakerLines = caretakerBannerLines(banners);
          const rehome = rehomeBannerLine(banners);
          const transit = transitBannerLine(banners);
          if (caretakerLines.length === 0 && !rehome && !transit) {
            // Only a caretaker or a foster reaches here — for the titular the
            // section already returned null via `isEmpty` above. They
            // genuinely have no arrangements to see, because arrangements are
            // the titular's to make; say so instead of leaving an unexplained
            // gap that reads as a bug.
            return <Body>Solo el titular ve los arreglos de esta mascota.</Body>;
          }
          return (
            <>
              {transit ? <Body>{transit}</Body> : null}
              {caretakerLines.map((line) => (
                <Body key={line}>{line}</Body>
              ))}
              {rehome ? <Body>{rehome}</Body> : null}
            </>
          );
        }}
      </Section>

      {/* OPEN CASES ------------------------------------------------------- */}
      {/* The count is the headline; the CODES are why this section exists.
          A person who reports a mordedura is handed a `CAS-XXXX-XXXX` on the
          web's receipt and then has to quote it — to a sanitary authority, on a
          form, over the phone. Until 2026-09-10 the payload carried the count
          alone, so the app could say "1 trámite abierto" and not WHICH one:
          a receipt you can only see once is not a receipt, which is why the
          code arrives on this READ and not on the write's answer.

          Each line now OPENS its case (M11), the app's own screen for the
          web's `/casos/{code}` — and the line still prints the code, so it can
          be read back to whoever asks for it. Whether this reader may see the
          case is the server's answer on that screen, not this line's. */}
      <Section view={view.cases} title="Trámites" isEmpty={(cases) => cases.openCount === 0}>
        {(cases) => (
          <>
            <Body>{casesLine(cases)}</Body>
            {cases.items.map((item) => (
              <LinkText
                key={item.casePublicCode}
                onPress={() => router.push(caseRoute(item.casePublicCode))}
              >
                {caseLine(item)}
              </LinkText>
            ))}
          </>
        )}
      </Section>

      {/* PREGNANCY -------------------------------------------------------- */}
      <Section view={view.pregnancy} title="Preñez" isEmpty={(pregnancy) => pregnancy === null}>
        {(pregnancy) =>
          // `null` never reaches here — `isEmpty` above already returned null
          // for it — but the contract types the section as `V1 | null`, so the
          // guard stays for the narrowing, not for a sentence.
          pregnancy === null ? null : (
            <>
              <Row label="Comenzó" value={formatIsoDate(pregnancy.startedAt)} />
              <Row label="Parto estimado" value={formatIsoDate(pregnancy.expectedBirthAt)} />
              {pregnancy.weeksAtDiagnosis !== null ? (
                <Row label="Semanas al diagnóstico" value={String(pregnancy.weeksAtDiagnosis)} />
              ) : null}
            </>
          )
        }
      </Section>

      {/* THE CAROUSEL IS DELIBERATELY NOT HERE ---------------------------- */}
      {/* "Tus otras mascotas" was rendered here until 2026-09-03 and is gone,
          not hidden. Three reasons, in order of weight:

          It does not belong on this screen. This is ONE animal's credential;
          the other animals are not a property of it. The web draws exactly
          this line and the header above quotes the decision ("el carousel lo
          quiero FUERA de la credencial") — this file kept it anyway.

          The destination already exists and is better. `/mascotas` lists the
          same pets with photo, species and status, one tap away. What rendered
          here was `<Row label={name} value="" />` — a label/value row with a
          permanently empty value column, i.e. a worse copy of a better screen,
          printed inside a national credential.

          And the reasoning that put it here is the bug. The header argued that
          DROPPING a section the server read would be quiet data loss. That
          turns every field in the payload into a UI block and lets the
          endpoint dictate the information architecture. `view.carousel` is
          still built by the view-model and still typed by the contract; not
          rendering it here loses nothing, because nothing was ever lost — the
          data has a home, and this was not it. */}
    </>
  );
}

/**
 * An ISO instant as a plain Argentine date.
 *
 * `Intl` with an explicit time zone is what keeps this off the DEVICE's zone —
 * a phone travelling with its owner must not renumber an animal's dates.
 */
function formatIsoDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date);
}

const styles = StyleSheet.create({
  stack: { gap: SPACE.sm },

  // Centred photo + facts below (PO 2026-10-05). Size / shadow knobs live in
  // `chrome-visual.ts` → `PHOTO_MOUNT`. Rise matches the taller band poke.
  idWrap: { gap: SPACE.md },
  photoStage: { alignItems: "center" },
  /**
   * Outer mount: hairline outline + soft drop. Inner `photo` clips the image
   * and wears the white surface ring.
   */
  photoMount: {
    width: PHOTO_MOUNT.size,
    height: PHOTO_MOUNT.size,
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    marginTop: -IDENTITY_POKE_OUT,
    borderRadius: PHOTO_MOUNT.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.surface,
    zIndex: 3,
    ...Platform.select({
      ios: {
        shadowColor: COLORS.ink,
        shadowOpacity: PHOTO_MOUNT.shadowOpacity,
        shadowRadius: PHOTO_MOUNT.shadowRadius,
        shadowOffset: { width: 0, height: PHOTO_MOUNT.shadowOffsetY },
      },
      android: { elevation: PHOTO_MOUNT.elevation },
      default: {},
    }),
  },
  photo: {
    flex: 1,
    borderRadius: PHOTO_MOUNT.radius - 1,
    borderWidth: PHOTO_MOUNT.ring,
    borderColor: COLORS.surface,
    backgroundColor: COLORS.stripe,
    overflow: "hidden",
  },
  photoImage: { width: "100%", height: "100%" },
  photoEmpty: { flex: 1, alignItems: "center", justifyContent: "center", gap: SPACE.xs },
  photoFailed: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.xs,
    color: COLORS.inkFaint,
    textAlign: "center",
  },
  /** The empty frame's invitation — accent, because the frame is a door now. */
  photoAdd: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.xs,
    color: COLORS.accent,
    textAlign: "center",
  },
  photoBadge: {
    position: "absolute",
    right: 4,
    bottom: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.surface,
  },
  idFacts: { gap: SPACE.xs, alignItems: "center" },
  petName: {
    fontFamily: FONTS.serif,
    fontSize: 26,
    lineHeight: 26 * 1.06,
    letterSpacing: 26 * TRACKING.tight,
    color: COLORS.ink,
    textAlign: "center",
  },
  memorial: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
  },
  pingBadge: {
    width: 44,
    height: 44,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
  },
  ping: {
    flex: 1,
    overflow: "hidden",
    backgroundColor: COLORS.focusRing,
    alignItems: "center",
    justifyContent: "center",
  },
  pingGrid: {
    ...StyleSheet.absoluteFill,
    opacity: 0.35,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
  },
  pingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.danger,
  },
  pingRing: {
    position: "absolute",
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.dangerBorder,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACE.xs,
    justifyContent: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: COLORS.canvas2,
    borderColor: COLORS.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS.chip,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.xs,
  },
  chipText: { fontFamily: FONTS.mono, fontSize: TYPE.sm, color: COLORS.inkSoft },

  calloutBody: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  stamp: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.lg,
    letterSpacing: TYPE.lg * TRACKING.wide,
    color: COLORS.ink,
  },
  // The action row's styles (`actionRow`, `action`, …) left with the row, into
  // `OwnerActionPanel` (owner-pet-actions): the card carries no actions.
  complianceDetail: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
    marginTop: -2,
  },
});

/**
 * The face's StyleSheet, exported for the geometry fences.
 *
 * jest has no Yoga, so the only way to keep the numbers the docblocks above
 * quote honest is arithmetic over the real style objects — see the QR ring
 * assertion in `PetDocumentScreen.test.tsx` and the band budget in
 * `DocumentChromeNative.geometry.test.ts`. Production reads `styles`; only the
 * tests read this alias.
 */
export const ownerFaceStyles = styles;
