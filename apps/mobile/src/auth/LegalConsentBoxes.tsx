// The three legal boxes, shared by `CrearCuentaScreen` (signup) and
// `AceptarCondicionesScreen` (re-acceptance by an existing account).
//
// WHY THREE BOXES AND NOT ONE (2026-10-07; legal review 2026-10-02, rows P9 and
// P10; PO decision D2 = b — a CONSERVATIVE INTERIM that counsel may loosen).
//   1. Términos y Política de privacidad — the box this app always had.
//   2. The international transfer, ON ITS OWN and set apart, naming Brasil and
//      Estados Unidos. It used to ride on box 1 ("incluida la transferencia…");
//      Dec. 1558/2001 art. 5 inc. 1 asks a consent given beside other
//      declarations to be "expresa y destacada", which a clause inside the
//      Terms box may not be.
//   3. "Tengo 18 años o más" — the review's minimum age measure; counsel fixes
//      the real threshold (13, 16 or 18) later.
// The sentences for 2 and 3 come from `@dim/contract/reference`, the same
// constants the web renders (app/(auth)/registro/SignupForm.tsx and
// components/legal/LegalConsentBoxes.tsx) — change them there, never here.
//
// MOVED OUT OF CrearCuentaScreen when the second caller arrived, which is the
// rule the old local `TosCheckbox` stated for itself ("it moves the day a
// second screen needs it"). Still not in `kit.tsx`: it is not a general boolean
// control, it is the legal act, with a fixed shape.
//
// `accessibilityRole="checkbox"` with `accessibilityState.checked` makes a
// screen reader announce two states. The document links are separate rows under
// the sentence, because a `Pressable` nested inside the checkbox's `Pressable`
// would swallow the tap.

import {
  ADULT_DECLARATION_SENTENCE,
  TRANSFER_CONSENT_NOTICE,
  TRANSFER_CONSENT_SENTENCE,
} from "@dim/contract/reference";
import * as Linking from "expo-linking";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { PRIVACY_URL, TERMS_URL } from "../config/api";
import { FONTS } from "../ui/fonts";
import { LinkText } from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TYPE } from "../ui/theme";

/** The Terms box sentence (box 1). No longer carries the transfer clause. */
export const TOS_SENTENCE = "Leí y acepto los Términos y condiciones y la Política de privacidad";

export type LegalConsents = {
  tosAccepted: boolean;
  transferAccepted: boolean;
  adultDeclared: boolean;
};

export const NO_LEGAL_CONSENTS: LegalConsents = {
  tosAccepted: false,
  transferAccepted: false,
  adultDeclared: false,
};

function ConsentCheckbox({
  sentence,
  checked,
  onToggle,
  disabled,
}: {
  sentence: string;
  checked: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  // The sentence once, so the visible label and the screen-reader name cannot
  // say two different things. A trailing period is added only when missing.
  const label = sentence.endsWith(".") ? sentence : `${sentence}.`;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={`${sentence.replace(/\.$/, "")}, obligatorio`}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      hitSlop={SPACE.sm}
      onPress={onToggle}
      style={styles.row}
    >
      <View style={[styles.box, checked ? styles.boxChecked : null]}>
        {/* Decoration. The state travels on `accessibilityState`. */}
        <Text accessibilityElementsHidden importantForAccessibility="no" style={styles.boxMark}>
          {checked ? "✓" : ""}
        </Text>
      </View>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

export function LegalConsentBoxes({
  value,
  onChange,
  disabled,
}: {
  value: LegalConsents;
  onChange: (next: Partial<LegalConsents>) => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.group}>
      <View style={styles.item}>
        <ConsentCheckbox
          sentence={TOS_SENTENCE}
          checked={value.tosAccepted}
          disabled={disabled}
          onToggle={() => onChange({ tosAccepted: !value.tosAccepted })}
        />
        <View style={styles.links}>
          <LinkText
            accessibilityHint="Se abre en el navegador"
            onPress={() => void Linking.openURL(TERMS_URL)}
          >
            Términos y condiciones
          </LinkText>
          <LinkText
            accessibilityHint="Se abre en el navegador"
            onPress={() => void Linking.openURL(PRIVACY_URL)}
          >
            Política de privacidad
          </LinkText>
        </View>
      </View>

      {/* SET APART: its own bordered panel with a heading — the "destacada"
          half of the requirement. */}
      <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.panelTitle}>
          Transferencia internacional de tus datos
        </Text>
        <ConsentCheckbox
          sentence={TRANSFER_CONSENT_SENTENCE}
          checked={value.transferAccepted}
          disabled={disabled}
          onToggle={() => onChange({ transferAccepted: !value.transferAccepted })}
        />
        {/* The art. 6 notice beside the box (legal review T3-1): purpose,
            recipients, withdrawal, rights — the web's same words. */}
        <Text style={styles.notice}>{TRANSFER_CONSENT_NOTICE}</Text>
        <View style={styles.links}>
          <LinkText
            accessibilityHint="Se abre en el navegador"
            onPress={() => void Linking.openURL(`${PRIVACY_URL}#proveedores`)}
          >
            Ver qué proveedores son y qué datos reciben
          </LinkText>
        </View>
      </View>

      <ConsentCheckbox
        sentence={ADULT_DECLARATION_SENTENCE}
        checked={value.adultDeclared}
        disabled={disabled}
        onToggle={() => onChange({ adultDeclared: !value.adultDeclared })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: SPACE.lg },
  item: { gap: SPACE.sm },
  row: { flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm },
  box: {
    width: TYPE.lg,
    height: TYPE.lg,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.surface,
    alignItems: "center",
    justifyContent: "center",
    // The TAP target is the whole row plus the hitSlop (WCAG 2.5.5); the
    // margin aligns the box with the first line of the label.
    marginTop: (TYPE.md * LEADING.md - TYPE.lg) / 2,
  },
  boxChecked: { borderColor: COLORS.accent, backgroundColor: COLORS.focusRing },
  boxMark: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.sm, color: COLORS.accent },
  label: {
    flex: 1,
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  // Indented to the label's left edge so the documents read as belonging to
  // the sentence above them rather than as more form rows.
  links: { gap: SPACE.xs, paddingLeft: TYPE.lg + SPACE.sm },
  panel: {
    gap: SPACE.sm,
    padding: SPACE.md,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: RADIUS.control,
  },
  notice: {
    paddingLeft: TYPE.lg + SPACE.sm,
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.ink,
  },
  panelTitle: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
});
