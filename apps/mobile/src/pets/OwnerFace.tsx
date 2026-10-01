// The FRONT face of the pet document — what the person responsible for the
// animal sees, composed the way the web's `CredentialFace` composes it:
// identity row (photo · name · breedLine · tags · QR) → Cumplimiento → Avisos
// → issuing foot, bound by labeled hairline dividers inside the chrome's
// framed sheet. (Two-face rewrite, PO decision 2026-08-28 — this file was
// `OwnerFaceScreen`, a standalone screen; the honesty rules below survived the
// recomposition unchanged.)
//
// THE CARD CARRIES NO ACTIONS since owner-pet-actions (PO, 2026-10-01). The
// pill row and the ⋯ Más list that ended this face moved BELOW the card, into
// `OwnerActionPanel`. Two doors stay on the document because they are parts of
// it: the QR (the public credential) and the photo frame (the photo screen).
//
// THIS IS NOT THE PUBLIC CREDENTIAL, AND IT DOES NOT REPLACE IT.
// `CredentialScreen` renders the anonymous public document — identical for the
// owner and for a stranger who scanned the QR. That document is now a ROUTE
// (`publicCredentialRoute`), one tap from this face's QR block, exactly where
// the web puts it (`/p/{token}` behind the owner card's QR).
//
// EVERY SECTION FAILS ON ITS OWN. The payload wraps each one, and
// `unavailable` means the server could not read it — NOT that it is empty.
// "No hay recordatorios activos" is a fact; "No se pudo leer esta sección" is
// a different fact; and a section that rendered as an empty view would be
// telling the owner the first one while the server meant the second.

import { useRouter } from "expo-router";
import { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import type { OwnerPetIdentitySection, OwnerPetObligationCardV1 } from "@dim/contract/api";
import { PET_ACTION_COPY } from "@dim/contract/reference";

import { publicCredentialPageUrl } from "../config/api";
import { CredentialQr } from "../credential/CredentialQr";
import { Icon } from "../ui/Icon";
import { Body, Card, Row, Unavailable } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, LinkText, SecondaryButton, pressedOpacity } from "../ui/kit";
import { caseRoute, publicCredentialRoute, recordEventRoute } from "../ui/routes";
import { COLORS, LEADING, RADIUS, SPACE, TRACKING, TYPE } from "../ui/theme";
import { FaceDivider, FaceSection, IDENTITY_POKE_OUT } from "./DocumentChromeNative";
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
  registeredBadgeWord,
  rehomeBannerLine,
  reminderDueLabel,
  transitBannerLine,
  truncationNote,
} from "./owner-face-view-model";

/**
 * The QR code's own size, inside the frame.
 *
 * The frame is 84 and React Native is border-box, so the 4-point surface ring
 * leaves 84 − 2×4 = 76 — the same 76 the photo's image fills, and the web's own
 * `.ln-qr-frame svg { width: 76px }`. The quiet zone is already inside the SVG
 * (`CredentialQr`'s QUIET_ZONE), so no padding is owed here.
 *
 * It was 64 between 61c4978f3 and 2026-09-03, under a docblock claiming the
 * smaller code was what landed the outer box on the photo's 84. That sentence
 * was false — `width: 84` is what sets the box — and the code has been restored
 * to the web's value. `PetDocumentScreen.test.tsx` pins the arithmetic.
 */
export const QR_SIZE = 76;

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

      {/* NO ACTION FOOTER since owner-pet-actions: the actions are the panel
          BELOW the card (`OwnerActionPanel`), and the document ends where a
          certificate does — with its issuer. */}

      {/* ISSUING FOOT ---------------------------------------------------- */}
      <IssuingFoot view={view} />
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
 * The line that makes this a document issued BY somebody rather than a screen
 * about an animal.
 *
 * Four things separate a credential from a card, and until 2026-09-03 this face
 * carried none of them: the issuing authority, the jurisdiction, the date of
 * issue, and a seal. This is the first three. A funcionario asked to accept an
 * identification looks for exactly these, and their absence is why the
 * 2026-09-03 review answered "no" to whether this reads as a national document.
 *
 * THE AUTHORITY IS A CONSTANT, NOT A FIELD, and saying so matters. The payload
 * has no `authority`; it is the same for every credential this system issues,
 * so a constant is the honest home for it. The other two ARE data:
 * `jurisdictionProvince`/`jurisdictionLocality` ride the identity section, and
 * `issuedAt` is a payload-envelope field — which is why it survives an identity
 * read that failed, and why the foot still names the issuer on a broken card.
 */
function IssuingFoot({ view }: { view: OwnerFaceView }) {
  const identity = view.identity.state === "ok" ? view.identity.data : null;
  const place = [identity?.jurisdictionLocality, identity?.jurisdictionProvince]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(", ");

  // "CONSULTADA", NOT "EMITIDA" (A3-documento-credencial-06). `issuedAt` is the
  // envelope's freshness stamp — the moment the SERVER COMPOSED THIS READ
  // (`app/api/v1/pets/[publicToken]/payload.ts`, `issuedAt: now`) — and printing
  // it under "date of issue" told a funcionario that a pet registered in 2024
  // had its libreta issued today, and something different again tomorrow. The
  // contract carries no real issuance date (the identity section has no
  // registration date), so the honest move is to name the date for what it is:
  // this is when the copy in your hand was read.
  //
  // An unreadable date does not become "Consultada el —". A document either
  // states the date or does not raise the subject; a dash where a date belongs
  // is the empty-state-as-fact this file's header argues against.
  const readOn = formatIsoDate(view.issuedAt);

  return (
    // The foot used to open with "REPÚBLICA ARGENTINA" in the slot a real
    // credential reserves for its ISSUING AUTHORITY — the style was even named
    // `footAuthority`. On the screen this file's own header calls "the thing a
    // funcionario is asked to accept as identification", that line stated the
    // State had issued this document. No convenio exists with any state body,
    // so the line was not a design flourish, it was a false attribution — and
    // the one Play reads as government impersonation. It is gone; the document
    // names only itself.
    //
    // "NACIONAL" DROPPED FROM THE NAME ITSELF (PO, 2026-09-24) for the same
    // reason: "Libreta Sanitaria Nacional" reads as a State-issued document —
    // Play checks for exactly that pattern — and the same false attribution
    // the line above already removed once. "Libreta Sanitaria" names what the
    // document is without claiming who issued it.
    <View style={styles.foot}>
      <Text style={styles.footLine}>Libreta Sanitaria{place ? ` · ${place}` : ""}</Text>
      {readOn === "—" ? null : <Text style={styles.footLine}>Consultada el {readOn}</Text>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Identity row
// ---------------------------------------------------------------------------

/**
 * The identity row: photo · name · QR, both frames rising into the band by the
 * same amount, with everything else full width underneath. It is the
 * composition of an identity document, and that is the point — this screen is
 * the thing a funcionario is asked to accept as identification.
 *
 * WHAT IT REPLACED, AND WHY THE OLD DOCBLOCK WAS WRONG. This file used to say,
 * as fact, that the web's phone layout put "the QR on its OWN full-width
 * centered row below". That was true of a flex layout the web no longer has.
 * `app/globals.css:1358` is now `display: grid` with
 * `grid-template-columns: auto minmax(0,1fr) auto` — a symmetric three-column
 * row — and the phone override that used to force the wrap
 * (`.ln-idrow { flex-wrap }`, `.ln-qr { flex-basis: 100% }`) applies FLEX
 * properties to a GRID and is inert. Mobile faithfully transcribed a rule that
 * had stopped firing, which is the cost of transcribing CSS by hand with
 * nothing fencing the result: token parity is fenced, layout parity is not.
 *
 * The visible symptom was a wasted column. The photo is 84 wide but only
 * contributes 28 points of layout height (the rest is pulled up into the
 * band), so the tall meta column beside it left an empty 84-wide rectangle
 * underneath — the "se pierde mucho espacio" in the 2026-09-03 review.
 *
 * WHY THE CENTRE COLUMN CARRIES ONLY THE NAME. A 360dp card is ~312 wide;
 * photo (84) + QR (84) + two 12 gaps leaves ~120 for the middle. The breed
 * line and the tag chips do not fit in 120 and would wrap into a ragged
 * stack, so they move BELOW the row where the full width is. The name and its
 * registration marker stay, centred, which is where a document puts them.
 *
 * THE QR IS UNCONDITIONAL AND TAPPABLE. It renders from the token alone, so a
 * degraded identity read must not take down the one block that links to the
 * public document a stranger can already see — hence the standalone arm below.
 * Tapping it opens the public credential route: an inert QR on a screen is a
 * control-shaped decoration.
 */
function IdentityRow({
  view,
  photoTarget,
}: {
  view: OwnerFaceView;
  /** The photo frame's door, from the panel; `null` = the frame is a picture only. */
  photoTarget: PanelTarget | null;
}) {
  const router = useRouter();

  const status = view.status.state === "ok" ? view.status.data : null;
  const situationActive = status?.situation != null;
  const showBadge = status?.petStatus === "active";
  const badgeWord = registeredBadgeWord(
    view.identity.state === "ok" ? view.identity.data.sex : null,
  );

  /**
   * The QR block, in whichever of the two arms is drawing it.
   *
   * `inRow` is not a style preference: the rise into the band belongs to the
   * flanking row, where there IS a band above the frame. In the standalone arm
   * the thing above the QR is the identity refusal box, and a frame that rose
   * 56 points there covered most of the sentence a reader is meant to read.
   */
  const renderQr = (inRow: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Ver credencial pública"
      accessibilityHint="Abre el documento público que ve cualquier persona que escanea el código."
      onPress={() => router.push(publicCredentialRoute(view.publicToken))}
      style={inRow ? [styles.qrFrame, styles.qrFrameInRow] : styles.qrFrame}
    >
      <CredentialQr
        value={publicCredentialPageUrl(view.publicToken)}
        size={QR_SIZE}
        label={`Código QR de la credencial pública de ${view.publicToken}`}
      />
    </Pressable>
  );

  return (
    <View style={styles.idWrap}>
      {view.identity.state === "unavailable" ? (
        <>
          <Unavailable title="Identidad" message={view.identity.message} />
          {/* The row cannot be built without an identity, but the public
              document exists regardless, so the QR keeps its old standalone
              form here rather than disappearing with the read that failed. */}
          <View style={styles.qrStandalone}>
            {renderQr(false)}
            <Text style={styles.qrCaption}>
              <Text style={styles.qrCaptionStrong}>Credencial pública{"\n"}</Text>
              {view.publicToken}
            </Text>
          </View>
        </>
      ) : (
        <View style={styles.idRow}>
          <PhotoFrame identity={view.identity.data} target={photoTarget} />
          {renderQr(true)}
        </View>
      )}

      {/* EVERYTHING ELSE IS BELOW THE FRAMES, AT FULL WIDTH, AND THE NAME
          LEADS IT. Measured on a real 360dp device on 2026-09-03: with the
          name in a centre column between the two frames it had ~120 points and
          "Pampa" — FIVE characters at the 26px serif step — was already
          truncating. The estimate in this file said ~120 would be tight; the
          phone said it was not enough, and the phone is the instrument.

          The frames still flank, which is the part that reads as a document,
          and the name gets the whole card width instead of the gap between
          them. Centred, because a document centres its subject. */}
      {view.identity.state === "unavailable" ? null : (
        <View style={styles.idFacts}>
          <View style={styles.nameRow}>
            <Text style={styles.petName}>{view.identity.data.name}</Text>
            {/* Default state: the registration badge sits beside the name.
                With an active situation it is DEMOTED to the quiet marker
                below — the situation (in the band chip) is the headline,
                registration the footnote. The web's exact demotion. */}
            {showBadge && !situationActive ? (
              <View style={styles.badgeReg}>
                <Icon name="check" size="sm" color={COLORS.accent} />
                <Text style={styles.badgeRegText}>{badgeWord}</Text>
              </View>
            ) : null}
          </View>
          {showBadge && situationActive ? (
            <View style={styles.regQuiet}>
              <Icon name="check" size="sm" color={COLORS.inkMuted} />
              <Text style={styles.regQuietText}>{badgeWord}</Text>
            </View>
          ) : null}
          {view.identity.data.breedLine ? <Body>{view.identity.data.breedLine}</Body> : null}
          {view.identity.data.tags.length > 0 ? (
            <View style={styles.chipRow}>
              {view.identity.data.tags.map((tag) => (
                <View key={tag.key} style={styles.chip}>
                  {tag.key === "loc" ? (
                    <Icon name="map-pin" size="sm" color={COLORS.inkSoft} />
                  ) : null}
                  <Text style={styles.chipText}>{tag.label}</Text>
                </View>
              ))}
            </View>
          ) : null}
          <Text style={styles.qrCaption}>
            <Text style={styles.qrCaptionStrong}>Credencial pública · </Text>
            {view.publicToken}
          </Text>
        </View>
      )}
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

  if (target === null) return <View style={styles.photo}>{picture}</View>;

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
      style={(state) => [styles.photo, pressedOpacity(state)]}
    >
      {picture}
      {showImage ? (
        <View style={styles.photoBadge}>
          <Icon name="edit" size="sm" color={COLORS.accent} />
        </View>
      ) : null}
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
  /**
   * The issuing foot. Quiet on purpose — an authority line that shouts is a
   * letterhead, not a seal. It sits on the document's ground with a hairline
   * above it so it reads as part of the sheet rather than as another block,
   * and it is the last thing on the face because that is where a certificate
   * puts its issuer.
   */
  foot: {
    gap: 2,
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderSoft,
    marginHorizontal: 16,
  },
  // `footAuthority` (the uppercase issuing-authority line) was removed with the
  // "República Argentina" text it styled — see the note at the foot's render.
  footLine: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    color: COLORS.inkFaint,
    textAlign: "center",
  },

  // Identity row — the two frames flank the card's edges and everything else
  // sits full width underneath; see IdentityRow's docblock for why the web's
  // "QR on its own row" was a rule that had already stopped firing. The photo
  // pokes up into the band (negative margin), ringed in the card's white like
  // the web's box-shadow ring. 84 / -56 / 12 are the web's own `.ln-photo`
  // values.
  idWrap: { gap: SPACE.md },
  /**
   * The two frames, flanking. `space-between` and nothing between them: the
   * photo takes the left edge, the QR the right, both rising into the band by
   * IDENTITY_POKE_OUT. Nothing lives in the gap — see the note at the facts
   * block for why the name came out of it.
   */
  idRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  photo: {
    width: 84,
    height: 84,
    marginTop: -IDENTITY_POKE_OUT,
    borderRadius: 12,
    borderWidth: 4,
    borderColor: COLORS.surface,
    backgroundColor: COLORS.stripe,
    overflow: "hidden",
    zIndex: 3,
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
  /**
   * The pencil on a frame that HAS a photo, so the frame reads as changeable
   * without a caption covering the animal. Inside the 76 the ring leaves, in the
   * corner furthest from the band.
   */
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
  /** The name and the facts, full width under the frames, centred. */
  idFacts: { gap: SPACE.xs, alignItems: "center" },
  nameRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  petName: {
    fontFamily: FONTS.serif,
    // The web's phone step for the credential name — globals.css
    // `@media (max-width: 720px) .ln-idname { font-size: 26px }`. Not a
    // named token on either side.
    fontSize: 26,
    lineHeight: 26 * 1.06,
    letterSpacing: 26 * TRACKING.tight,
    color: COLORS.ink,
  },
  badgeReg: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: COLORS.celeste100,
    backgroundColor: COLORS.focusRing,
  },
  badgeRegText: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * 0.12,
    textTransform: "uppercase",
    color: COLORS.accent,
  },
  regQuiet: { flexDirection: "row", alignItems: "center", gap: 6 },
  regQuietText: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * 0.12,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs },
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

  /** The degraded-identity arm, where the QR is the only thing left to draw. */
  qrStandalone: { alignItems: "center", gap: SPACE.xs, marginTop: SPACE.sm },
  /**
   * The QR frame MIRRORS THE PHOTO in everything that is about the FRAME: same
   * 84 box, same 12 radius, same 4-point surface ring. Two matched frames at
   * the two edges of the row with the name centred between them is the
   * composition of an identity document, and the mirroring is what makes it
   * read as one rather than as a photo with a decoration beside it. Change one
   * of those three numbers and change both.
   *
   * WHAT IS NOT HERE, AND WHY. The -56 rise is NOT part of the frame; it is
   * part of being IN THE ROW, so it lives in `qrFrameInRow` below and only the
   * row arm applies it. It used to sit here, shared by both arms, and the
   * degraded-identity arm — where the QR stands alone under the identity
   * refusal, with no band above it — pulled the frame up over that refusal's
   * own text. A frame that rises into a band that is not there is not a
   * mirror, it is a bug (2026-09-03 review, B1).
   *
   * The code inside is `QR_SIZE` (76): 84 minus the 4-point ring on each side,
   * border-box. See that constant for the arithmetic and the web parity.
   */
  qrFrame: {
    width: 84,
    height: 84,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.surface,
    borderWidth: 4,
    borderColor: COLORS.surface,
    borderRadius: 12,
  },
  /**
   * The rise, and ONLY in the flanking row — exactly what `photo` carries, so
   * the two frames enter the band together. Mirror any change to `photo`'s
   * marginTop/zIndex here; that pairing is what `DocumentChromeNative`'s band
   * budget assumes, and `DocumentChromeNative.geometry.test.ts` pins it.
   */
  qrFrameInRow: { marginTop: -IDENTITY_POKE_OUT, zIndex: 3 },
  qrCaption: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    color: COLORS.inkMuted,
    textAlign: "center",
  },
  qrCaptionStrong: { fontFamily: FONTS.monoSemibold, color: COLORS.inkSoft },

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
