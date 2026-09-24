// The FRONT face of the pet document — what the person responsible for the
// animal sees, composed the way the web's `CredentialFace` composes it:
// identity row (photo · name · breedLine · tags · QR) → Cumplimiento → Avisos
// → action footer, bound by labeled hairline dividers inside the chrome's
// framed sheet. (Two-face rewrite, PO decision 2026-08-28 — this file was
// `OwnerFaceScreen`, a standalone screen; the honesty rules below survived the
// recomposition unchanged.)
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
//
// CONTROLS WITHOUT A NATIVE DESTINATION ARE DRAWN DISABLED, NOT OMITTED. The
// web's action row and ⋯ Más sheet shape this document; omitting "Editar
// datos" because the app cannot edit would make the card look like a different
// product, which is the thing the PO ordered against ("1 solo perfil mobile
// native, lo más símil al web posible"). So the row renders — recognisably
// itself, visibly not available, with honest copy — the same doctrine
// `DISABLED_OPACITY`'s header records. A disabled control announces its state
// (`accessibilityState.disabled`) and its reason (the caption).

import { useRouter } from "expo-router";
import { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import type { OwnerPetObligationCardV1 } from "@dim/contract/api";

import { publicCredentialPageUrl } from "../config/api";
import { CredentialQr } from "../credential/CredentialQr";
import { Icon } from "../ui/Icon";
import { Body, Card, Row, Unavailable } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, ListRow, SecondaryButton, pressedOpacity } from "../ui/kit";
import {
  caretakerPetRoute,
  editPetRoute,
  lostModeRoute,
  petPhotoRoute,
  publicCredentialRoute,
  recordEventRoute,
  rehomeRoute,
  returnPetRoute,
  sharesRoute,
  transferPetRoute,
  vaccineRemindersRoute,
} from "../ui/routes";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";
import { FaceDivider, FaceSection, IDENTITY_POKE_OUT } from "./DocumentChromeNative";
import {
  type OwnerFaceGates,
  type OwnerFaceView,
  type SectionView,
  alertHeadline,
  alertTone,
  caretakerBannerLines,
  caseLine,
  casesLine,
  complianceStampLabel,
  complianceSummaryLabel,
  isAttestationDoorCard,
  ownerFaceGates,
  registeredBadgeWord,
  rehomeBannerLine,
  reminderDueLabel,
  titularOnlyRowCaption,
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

export function OwnerCredentialFace({ view }: { view: OwnerFaceView }) {
  // COMPUTED ONCE AND HANDED DOWN, since 2026-09-10. It used to live inside
  // `ActionFooter`, which was the only consumer; the compliance section now
  // carries a door of its own (the PPP attestation) and two calls to the same
  // pure function would be two places for the face to disagree with itself
  // about what this viewer may do.
  const gates = ownerFaceGates(view);
  return (
    <>
      <FaceSection>
        <IdentityRow view={view} />
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
                gates={gates}
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

      {/* ACTION FOOTER --------------------------------------------------- */}
      <FaceDivider />
      <FaceSection>
        <ActionFooter view={view} gates={gates} />
      </FaceSection>

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
  gates,
  publicToken,
}: {
  card: OwnerPetObligationCardV1;
  gates: OwnerFaceGates;
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
      {isAttestationDoorCard(card, gates) ? (
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
    <View style={styles.foot}>
      <Text style={styles.footLine}>Libreta Sanitaria Nacional{place ? ` · ${place}` : ""}</Text>
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
function IdentityRow({ view }: { view: OwnerFaceView }) {
  // A photo the record HAS and this phone could not fetch (S-1 / VT-2). RN's
  // <Image> draws nothing on a failed load, and a blank frame reads as "this
  // animal has no photo" — a different, false claim.
  const [photoFailed, setPhotoFailed] = useState(false);
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
          <View style={styles.photo}>
            {view.identity.data.photoUrl && !photoFailed ? (
              <Image
                source={{ uri: view.identity.data.photoUrl }}
                style={styles.photoImage}
                accessibilityIgnoresInvertColors
                accessible
                accessibilityLabel={`Foto de ${view.identity.data.name}`}
                onError={() => setPhotoFailed(true)}
              />
            ) : (
              <View style={styles.photoEmpty}>
                <Icon name="paw" size="lg" color={COLORS.inkFaint} />
                {/* NAMED, NOT BLANK (S-1 / VT-2). A photo that exists on the
                    record and would not load is a fact about this phone's last
                    ten seconds; the paw alone says "no hay foto", which is a
                    claim about the animal's record and is false here. */}
                {photoFailed ? <Text style={styles.photoFailed}>Foto no disponible</Text> : null}
              </View>
            )}
          </View>
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
// Action footer
// ---------------------------------------------------------------------------

/**
 * The web's action row, with this app's destinations behind it — and the
 * web's rows drawn DISABLED where the app has none (see the header).
 *
 * WHAT IS OFFERED UNCONDITIONALLY, AND WHY, is inherited verbatim from the
 * screen this face used to be:
 *
 *   · Modo perdida — the cockpit serves both directions (marking lost and
 *     running the search), and WHICH of the five commands this caller may
 *     send is decided by the server and reported in that payload. A CTA that
 *     appeared only when this face happened to know the animal was lost would
 *     hide the entry point in the one state where somebody needs it fastest.
 *   · Compartir / Transferir — who may mint a link is decided by that
 *     payload's `capabilities`, and who may transfer by the transfer writer's
 *     own ownership check (the ACTIVE `role='owner'` row — a rule narrower
 *     than `viewer.role` can express). A CTA hidden on a guess would be this
 *     screen inventing a rule it cannot see; the server refuses and the
 *     cockpit renders the refusal.
 *   · Cuidador temporal — same shape: the rule is a DENY
 *     (`caretaker-sub-designation`) the server owns. And it sits BESIDE
 *     transferir, never folded into it: a transfer hands the animal over for
 *     good, a grant lends a bounded set of powers. A person who confused them
 *     would give away a pet they meant to lend.
 *   · Anotar — the write the libreta exists for; the server decides whether
 *     this caller may write.
 *
 * WHAT IS ROLE-GATED CLIENT-SIDE: the DISABLED rows, because a dead control has
 * no server to refuse it — and, since A3-documento-credencial-04, the rows the
 * web's own gates take away. The paragraph above is still the rule for the
 * unconditional four; what it did NOT cover is the two facts the payload
 * carries and this footer ignored: whether the animal is registered as
 * fallecida, and whether this viewer is the titular. `ownerFaceGates` is where
 * those two are read and why each gate is the web's; a caretaker never sees
 * Editar datos or Contactos de emergencia, and an org member gets Compartir and
 * nothing owner-only, both unchanged.
 *
 * "THE SERVER DECIDES" IS NOT AN ANSWER FOR A REFUSAL THAT ARRIVES AFTER A FORM.
 * Transferir and Cuidador are refused for a non-titular only once the address,
 * the dates and the note have been typed, and the sentence that comes back
 * describes an arrangement the person cannot see. An INERT row with a caption
 * says the same thing before the typing, and the server refusal stays exactly
 * where it was.
 */
function ActionFooter({ view, gates }: { view: OwnerFaceView; gates: OwnerFaceGates }) {
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);

  const isOrgViewer = view.viewerRole === "org_member";
  const petName = view.identity.state === "ok" ? view.identity.data.name : null;
  const nameParams = petName === null ? {} : { name: petName };

  if (isOrgViewer) {
    // The web's org action row: Compartir, read-only, and nothing else — no
    // capture, no ⋯ Más. The unconditional offers above are person-path
    // reasoning; an org member acts from the org portal.
    return (
      <View style={styles.actionRow}>
        <FaceAction
          icon="share"
          label="Compartir"
          onPress={() => router.push(sharesRoute(view.publicToken))}
        />
      </View>
    );
  }

  return (
    <View style={styles.stack}>
      <View style={styles.actionRow}>
        {/* DECEASED COLLAPSES THE ROW TO [Compartir][Más], which is the web's
            own shape (`PetActionRow.tsx:22`, ADR-15/REQ-9.3). Not drawn inert
            here, unlike the Más rows below: the pill row is four items wide and
            a fallecida animal has no write left to offer, so two greyed pills
            would be furniture about nothing. */}
        {gates.canRecordEvent ? (
          <FaceAction
            icon="libreta"
            label="Anotar"
            accessibilityHint="Asentar un evento en la libreta."
            onPress={() => router.push(recordEventRoute(view.publicToken))}
          />
        ) : null}
        <FaceAction
          icon="share"
          label="Compartir"
          accessibilityHint="Crear o revocar links de la libreta, y mostrarla en la credencial pública."
          onPress={() => router.push(sharesRoute(view.publicToken))}
        />
        {/* KEPT ON A LOST ANIMAL, where the web drops it — see `ownerFaceGates`.
            The row is the cockpit for both directions here. */}
        {gates.canOpenLostMode ? (
          <FaceAction
            icon="alert-triangle"
            label="Modo perdida"
            danger
            accessibilityHint="Marcar la mascota como perdida, seguir la búsqueda o marcarla encontrada."
            onPress={() => router.push(lostModeRoute(view.publicToken))}
          />
        ) : null}
        <FaceAction
          icon="ellipsis"
          label="Más"
          expanded={moreOpen}
          onPress={() => setMoreOpen((open) => !open)}
        />
      </View>

      {moreOpen ? <MoreList view={view} gates={gates} nameParams={nameParams} /> : null}
    </View>
  );
}

/**
 * The expanded "Más" list.
 *
 * ITS OWN COMPONENT SINCE A3-documento-credencial-04, and not for tidiness:
 * the per-row gates the finding asked for pushed `ActionFooter` past the
 * cognitive-complexity ceiling the repo lints for. The split is along the seam
 * that was already there — the pill row is one decision, the sheet is another —
 * and every gate it reads is precomputed in `ownerFaceGates`.
 */
function MoreList({
  view,
  gates,
  nameParams,
}: {
  view: OwnerFaceView;
  gates: OwnerFaceGates;
  /** `{ name }` when the identity section loaded, `{}` when it did not. */
  nameParams: { name?: string };
}) {
  const router = useRouter();
  const titularOnlyCaption = titularOnlyRowCaption(gates);
  return (
    <View style={styles.moreList}>
      {/* EDITAR DATOS LIVES HERE, not on the face, since 2026-09-04. The
            face had five pills in a two-column grid, so the fifth stood
            alone on a third row; the one to move is the one with no moment.
            Anotar and Compartir both happen with the animal in front of you
            (a symptom as it appears, a credential handed to a vet), and Modo
            perdida is the emergency. Correcting a name or a colour is a
            once-ever edit that can afford a tap.

            FIRST IN THE LIST, and that position is the precedent rather than
            a leftover: the web's `deriveMasSheetItems` opens with "Editar
            datos y ficha". This row landed eighth when it was first moved,
            because it was folded into the non-caretaker fragment further
            down and inherited that fragment's place — citing the web for the
            destination while contradicting it on the order. It carries its
            own gate now so position and permission are two decisions instead
            of one accident; the gate itself is unchanged from the face row it
            replaces, and it is READ FROM `gates` rather than re-derived here
            (finding F6): `canEditIdentity` was computed and never used while
            this row tested `view.viewerRole` inline, which is the one thing
            this component's docblock promises it does not do. */}
      {gates.canEditIdentity ? (
        <MoreRow
          label="Editar datos"
          accessibilityHint="Cambiar el nombre, la raza y el color. Queda registrado en la libreta."
          onPress={() => router.push(editPetRoute(view.publicToken))}
        />
      ) : null}
      <MoreRow
        label="Credencial pública"
        onPress={() => router.push(publicCredentialRoute(view.publicToken))}
      />
      {/* THE REMINDERS DOOR, moved here from the card below the document (PO
            decision 2026-09-16). Both reminder operations — schedule one,
            delete one that no longer applies — live on `/vacunas`, and this is
            the only way in. It sits here rather than under an empty card
            because Más is where somebody looks for an action that is not one
            of the four on the face, and because a card whose only job was to
            hold this button still had to draw a title and announce an absence
            on every healthy animal's document.
            UNCONDITIONAL, like "Credencial pública" above it. The gates in this
            list answer "may this person do this"; scheduling a reminder is not
            gated — `remindersOffer` reads the list only to word the button, and
            the write does not read the list at all. A row that disappeared when
            the reminders section failed to load would be a dead end caused by
            an unrelated read. */}
      <MoreRow
        label="Recordatorios de vacunas"
        accessibilityHint="Programar un recordatorio de vacuna, o eliminar uno que ya no hace falta."
        onPress={() => router.push(vaccineRemindersRoute(view.publicToken))}
      />
      {/* LA FOTO — deliberately NOT behind the caretaker gate, matching the
            server's own gate: `POST /pets/{token}/photo` takes any holder
            role, because `titular-only.ts` lists photos among what a
            caretaker MAY do and a caretaker photographing the animal in
            their care is the case the role exists for. Whether this BUILD
            can pick a photo is the image-picker seam's answer, and the
            screen this row opens says it honestly either way. */}
      <MoreRow
        label="Foto de la mascota"
        accessibilityHint="Elegir la foto que muestra la credencial."
        onPress={() => router.push(petPhotoRoute(view.publicToken))}
      />
      {/* TITULAR-ONLY AND ACTIVE-ONLY, the web's own pair of gates
            (`MasSheet.helpers.ts:97-118`). A deceased animal loses both rows
            outright — the web's deceased early-return sits above them — and
            every other refusal is drawn inert with the reason, because the
            alternative is a co-owner typing an address into a form whose
            answer will describe an arrangement they cannot see. */}
      {gates.isDeceased ? null : (
        <>
          <MoreRow
            label="Transferir la titularidad"
            accessibilityHint="Ofrecerle esta mascota a otra persona. No cambia nada hasta que acepte."
            caption={titularOnlyCaption ?? undefined}
            onPress={
              gates.canTransfer
                ? () =>
                    router.push({
                      pathname: transferPetRoute(view.publicToken),
                      params: nameParams,
                    })
                : undefined
            }
          />
          <MoreRow
            label="Cuidador temporal"
            accessibilityHint="Dejarle la mascota a alguien de confianza por un tiempo, o terminar un cuidado en curso."
            caption={titularOnlyCaption ?? undefined}
            onPress={
              gates.canDesignateCaretaker
                ? () =>
                    router.push({
                      pathname: caretakerPetRoute(view.publicToken),
                      params: nameParams,
                    })
                : undefined
            }
          />
        </>
      )}
      {/* DEVOLUCIÓN — incondicional para todo holder por vía persona, y esa
            es una diferencia con la web que se declara en vez de esconderse.
            `deriveMasSheetItems` sólo agrega su fila "Confirmar devolución"
            cuando ya hay una propuesta pendiente, con lo cual el MODO DE
            INICIACIÓN de esa misma página —proponerle la devolución al refugio
            que te dio el animal en adopción, o al que te lo dio en tránsito—
            no se alcanza desde ninguna navegación del navegador. La capacidad
            existe en el servidor y en la página; lo que falta ahí es el enlace.

            LA FILA NO ADIVINA NADA. Qué se puede hacer lo contesta el servidor
            en `capabilities`, y los tres estados que no ofrecen nada dicen por
            qué. Es la misma regla que la fila de "Contactos de emergencia" de
            arriba: si el bloque al que lleva es accionable o no es del
            servidor, no de la fila. */}
      {gates.canOpenReturn ? (
        <MoreRow
          label="Devolución"
          accessibilityHint="Responder a quien quiere devolverte la mascota, o proponer devolvérsela a la organización que te la dio."
          onPress={() => router.push(returnPetRoute(view.publicToken))}
        />
      ) : null}
      {/* THE TWO FALSE "Disponible en la web" ROWS. Both destinations are
            hidden by the web for a deceased animal — `chapita` sits after the
            deceased early-return and `page.tsx` nulls its data, and
            buscar-hogar / acompañamiento is in the same suppressed block — so
            on a fallecida pet these rows promised a page that does not exist
            THERE either, which is worse than an inert row: it sends somebody
            to a browser to look for it. */}
      {/* INERT ON PURPOSE, AND THIS REVERSES A DECISION MADE EARLIER THE SAME DAY.
          On 2026-09-11 these two rows were given `onPress` handlers that opened
          the browser, because until then they rendered with none and a person
          tapping one could not tell an inert row from a broken button. That
          reasoning was about the ROW. The product owner's is about the PERSON,
          and it outranks it: a tester sent out to a browser mid-flow does not
          come back, and the pilot is measured in people who keep using the app.
          A row that says where the thing lives costs a moment of mild
          disappointment; a browser tab costs the session.
          `ListRow` renders an `onPress`-less row muted and announces
          `disabled`, and the caption says where it is — which is what makes
          this different from the silent dead rows those handlers replaced. */}
      {gates.showWebOnlyRows ? (
        <MoreRow label="Chapa física" caption="Se pide desde la web" />
      ) : null}
      {/* ONE DESTINATION, TWO LABELS, TWO AUDIENCES — AND NOT AN `else`
            (finding F2, review 2026-09-07). The else arm here covered `owner`
            AND `co_owner` AND `org_member`, so a co-owner read "Acompañamiento
            de adopción — Disponible en la web", went to a browser and got a
            404: `buscar-hogar/page.tsx` keeps only `owner` and `foster` and
            `notFound()`s the rest. That is the identical shape the web fixed on
            2026-08-20 — a live row pointing at a page its own destination
            refuses — just on the role axis instead of the status one. Both
            gates now say who, in `ownerFaceGates`, where the audience is
            testable without rendering. */}
      {/* THE ROW IS NOW A DOOR, not a label that looks like one. Both this row
            and "Chapa física" above rendered with no `onPress`, which draws
            `ListRow`'s INERT arm — muted, announcing `disabled` — while the
            caption told the person the thing exists somewhere else. A person
            tapping it could not tell that from a broken button. The caption is
            kept and now KEPT: it says where the capability lives and the tap
            takes them there. See `findHomeWebUrl` for why the URLs are built in
            the view model and not through `deepLinkMap`.

            THE FOSTER'S ROW STAYS WEB-ONLY, which the comment below already
            settled: its ask is `foster`'s `sendRehomeRequest`, a different
            action in a different module from the titular's `RehomeScreen`. */}
      {/* Same reversal, same reason — see the note on "Chapa física" above. */}
      {gates.canSeeFindHome ? (
        <MoreRow label="Buscar hogar" caption="Se hace desde la web" />
      ) : null}
      {/* LIVE SINCE 2026-09-10: `GET|POST /pets/{token}/rehome` reaches the
            three use-cases the web's buscar-hogar page reaches, and
            `RehomeScreen` is the titular's surface. The FOSTER's row above
            stays web-only — its ask is a different action in a different
            module (`foster`'s `sendRehomeRequest`), not this door. */}
      {gates.canSeeAdoptionSupport ? (
        <MoreRow
          label="Acompañamiento de adopción"
          accessibilityHint="Pedirle a una organización verificada que acompañe la adopción, cancelar el pedido, o dar de baja el acompañamiento."
          onPress={() => router.push(rehomeRoute(view.publicToken))}
        />
      ) : null}
      {/* THE SAME DESTINATION AS "Editar datos" above, and that is the
            web's two `?sheet=` rows meeting a stack navigator: both
            halves live on one screen there. The row survives as its own
            entry point because the two promise different things — a
            person looking for "a quién llamamos" is not looking to edit a
            name — and because the web keeps it. Whether the block it
            lands on is EDITABLE is the server's call, not this row's: a
            co-owner and a foster reach it and are shown the reason
            instead of a form. Only the caretaker is hidden here, which is
            `deriveMasSheetItems`' own rule. */}
      {gates.canSeeEmergencyContacts ? (
        <MoreRow
          label="Contactos de emergencia"
          accessibilityHint="El veterinario y la persona a la que llamamos por esta mascota."
          onPress={() => router.push(editPetRoute(view.publicToken))}
        />
      ) : null}
      {gates.showWebOnlyRows ? <MoreRow label="Viaje y movilidad" caption="Próximamente" /> : null}
      {/* FALLECIMIENTO — LAST, AND THE PLACEMENT IS A CHOICE THIS FILE MADE.
            Unlike the attestation door above, NO docblock anywhere names a home
            for `death`: `WRITABLE_KINDS` lists the three kinds "reached from
            somewhere else" and death is not one of them, and neither the
            contract's `death` schema nor the form on `RecordEventScreen` says
            where it is opened from. So this is argued rather than cited.

            NOT IN THE PICKER, which is the one thing that was settled. An owner
            scrolling `RECORD_KINDS` for "Peso" must not pass "Fallecimiento" on
            the way, and that list is explicitly ordered "by how often a person
            reaches for it" — an act that happens once, at the end, has no
            frequency to be sorted by.

            HERE, BECAUSE THIS IS ALREADY THE LIST OF ONCE-EVER ACTS. Transferir
            la titularidad, Cuidador temporal and Devolución are all lifecycle
            changes rather than libreta entries, and all three live behind the
            same deliberate extra tap. The web agrees on the SEPARATION though
            not on the furniture: its capture menu files "Reportar fallecimiento"
            under the "Incidentes" heading, apart from "Salud" — a grouping a
            flat native picker cannot express, and this sheet is the nearest
            honest thing to it.

            LAST IN THE LIST, with nothing under it. A terminal act adjacent to
            "Foto de la mascota" reads as one more option; at the bottom, after
            a person has passed everything else, it reads as what it is. The
            caption says what it does BEFORE the tap, the same warning the form's
            own subtitle and its "Asentar el fallecimiento" button carry after
            it — three chances to stop, none of them casual.

            THE LABEL IS THE WEB'S OWN ("Reportar fallecimiento",
            ALL_CAPTURE_OPTIONS): a person who used one surface should recognise
            the other. */}
      {gates.canRecordDeath ? (
        <MoreRow
          label="Reportar fallecimiento"
          caption="Cierra el registro del animal"
          accessibilityHint="Asentar el fallecimiento. Se cierra el registro del animal y después sólo se pueden agregar notas."
          onPress={() => router.push(recordEventRoute(view.publicToken, { kind: "death" }))}
        />
      ) : null}
    </View>
  );
}

/**
 * One labeled action pill — the web's `.ln-act` (icon + short text, bordered).
 *
 * With no `onPress` the pill is the honest-disabled rendering: same pill,
 * muted, announcing `disabled` — recognisably itself, visibly not available —
 * with the caption saying why. The computed state feeds the behaviour, the
 * styling and the announcement, so the three cannot disagree (the
 * SecondaryButton lesson).
 */
function FaceAction({
  icon,
  label,
  caption,
  danger = false,
  expanded,
  accessibilityHint,
  onPress,
}: {
  icon: string;
  label: string;
  caption?: string;
  danger?: boolean;
  expanded?: boolean;
  accessibilityHint?: string;
  onPress?: () => void;
}) {
  const isInert = onPress === undefined;
  const inkColor = isInert ? COLORS.inkMuted : danger ? COLORS.seal : COLORS.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isInert, ...(expanded === undefined ? {} : { expanded }) }}
      disabled={isInert}
      onPress={onPress}
      style={(state) => [styles.action, danger ? styles.actionDanger : null, pressedOpacity(state)]}
    >
      <Icon name={icon} size="sm" color={inkColor} />
      <View>
        <Text style={[styles.actionLabel, { color: inkColor }]}>{label}</Text>
        {caption === undefined ? null : <Text style={styles.actionCaption}>{caption}</Text>}
      </View>
    </Pressable>
  );
}

/**
 * One row of the expanded "Más" list. No `onPress` → honest-disabled row.
 *
 * This WAS the primitive, hand-rolled here, and it is now `ListRow` in the kit
 * — same markup, same styles, same inert arm — because RecordEventScreen
 * needed exactly this shape, could not reach it, and reached for a `Card`
 * instead. The alias stays so the call sites below read as they always did.
 */
const MoreRow = ListRow;

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
 * door is more findable there than it was under a card about nothing.
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
  // card to sit in; with the door in Más they would be a titled box whose only
  // content is the news that there is no news.
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
 * credencial").
 */
export function OwnerExtraSections({ view }: { view: OwnerFaceView }) {
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

          `selectable` is the whole affordance. There is no case screen in this
          build and no clipboard button (expo-clipboard is a native dep on the
          D2 batch), so long-press-to-copy is what a code is FOR here, and the
          same idiom TurnoDetailScreen already set for its token. A row styled
          like a link that navigated nowhere would be the worse answer. */}
      <Section view={view.cases} title="Trámites" isEmpty={(cases) => cases.openCount === 0}>
        {(cases) => (
          <>
            <Body>{casesLine(cases)}</Body>
            {cases.items.map((item) => (
              <Body key={item.casePublicCode} selectable>
                {caseLine(item)}
              </Body>
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

  /**
   * The action row, and what "ordenado" turned out to mean.
   *
   * It was `flexWrap` over CONTENT-SIZED pills, so the actions — of
   * different label lengths — wrapped into ragged rows with a different right
   * edge on each line. Centring alone would have kept the ragged widths and
   * only moved the ragged edge to both sides.
   *
   * So the cells are EQUAL: `flexBasis: 48%` gives two per row whatever the
   * label says. A grid reads ordered because the eye can find the column; a
   * wrap never can.
   *
   * THE GRID IS NOW FULL, which is the second half of the fix. Two columns over
   * five pills left a 2+2+1 orphan on the last row, and `justifyContent:
   * center` only moved that orphan to the middle — a lone centred pill still
   * reads as an unfinished row rather than a deliberate one. "Editar datos"
   * moved into the ⋯ Más sheet (see the row there for why it was the one to
   * move), so the four remaining pills — "Anotar", "Compartir", "Modo perdida",
   * "Más" — fill 2+2 exactly. The centring stays because the org-viewer branch
   * above renders a single pill and wants it centred.
   */
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: SPACE.sm,
  },
  action: {
    flexBasis: "48%",
    flexGrow: 0,
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.sm,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: RADIUS.button,
    backgroundColor: COLORS.surface,
  },
  actionDanger: { borderColor: COLORS.dangerBorder },
  actionLabel: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md },
  actionCaption: { fontFamily: FONTS.sans, fontSize: TYPE.xs, color: COLORS.inkMuted },
  complianceDetail: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
    marginTop: -2,
  },

  moreList: { gap: SPACE.xs },
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
