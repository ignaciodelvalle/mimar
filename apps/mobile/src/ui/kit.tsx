// The Libreta Nacional primitives, for React Native.
//
// WHAT THIS IS FOR
// ---------------------------------------------------------------------------
// The web app has a small set of form and surface primitives — `LnField`,
// `LnInput`, `LnCard`, `LnButton` — and every citizen screen is built out of
// them. This app had none: six screens, six `StyleSheet.create` calls, system
// font throughout, and a neutral grey palette that had never matched the web's
// warm cream. The two products did not look related, which is what the PO saw
// when they put the emulator next to the browser.
//
// These are the same primitives, in the same tokens, drawn by React Native.
// Not a port — a port would drag `className` plumbing across a boundary that
// does not have CSS. What crosses is the DESIGN: the fonts, the palette, the
// geometry, the spacing rhythm, and the field anatomy (mono uppercase label,
// seal-red required asterisk, warm border, celeste focus ring).
//
// WHERE THIS DELIBERATELY DIFFERS FROM THE WEB, AND WHY
// ---------------------------------------------------------------------------
// Three deviations, each because the web's own token scale says so or because
// a phone is not a browser. None of them is a taste call:
//
//   · SUBTITLE at 14px, not the login page's `text-sm` (12px). The scale in
//     globals.css assigns 12px to "secondary labels, table cells, chips" and
//     14px to "body secondary, form help". A subtitle under a page title is
//     the second thing; the login page uses the wrong step for the role, and
//     copying that would be copying the mistake rather than the design.
//
//   · LINKS at 14px with a 44px touch target, not the login page's `text-xs`
//     (10px). A 10px link is a fine mouse target and a poor thumb target;
//     WCAG 2.5.5 is why `LN_CONTROL_CLASS` already carries `min-h-[44px]` on
//     the web's own controls. The floor applies to everything tappable here.
//
//   · BUTTONS are pills, which the login CTA is not. See the note on `RADIUS`
//     in theme.ts: that CTA is one of the 307 grandfathered raw `<button>`s
//     `check-raw-buttons.mjs` counts as debt, and the decided citizen geometry
//     (X2-S2, PO decision 2026-07-29) is `--radius-pill`.
//
// Everything else is the web's value, read from `@dim/contract/tokens` and
// proven still current by `pnpm lint:token-parity`.
//
// WEIGHT IS PART OF THE FAMILY NAME. React Native does not synthesize weights
// on Android, so `fontWeight: "600"` over a family whose SemiBold face was
// never registered renders Regular, silently. Every style here names a face
// (`FONTS.sansSemibold`) and no style sets `fontWeight`. See fonts.ts.

import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import type { ReactNode, Ref, RefObject } from "react";
import { createContext, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  type GestureResponderEvent,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  type PressableAndroidRippleConfig,
  type PressableStateCallbackType,
  RefreshControl,
  ScrollView,
  type ScrollViewProps,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import { type Edge, SafeAreaView } from "react-native-safe-area-context";

import { Icon } from "./Icon";
import {
  dateInputToLocalDate,
  localDateToDateInput,
  localDateToTimeInput,
  maskDateInput,
  maskTimeInput,
  timeInputToLocalDate,
} from "./date-input";
import { FONTS } from "./fonts";
import {
  COLORS,
  DISABLED_OPACITY,
  LABEL_TRACKING_EM,
  LEADING,
  PRESSED_OPACITY,
  RADIUS,
  SPACE,
  TOUCH_TARGET,
  TRACKING,
  TYPE,
} from "./theme";

// ---------- Screen ---------------------------------------------------------

/**
 * The page: cream ground, safe area, and a scroll view with the web's gutter.
 *
 * `p-6` on the web's login `<main>` is 24px, which is `SPACE.xl2`. The gap
 * between blocks is the caller's business — screens differ — so this sets the
 * gutter and a default rhythm and gets out of the way.
 */
/**
 * The Screen's own ScrollView, offered to descendants that need to move it —
 * today that is `useScrollToError` (src/ui/use-scroll-to-error.ts), the mobile
 * mirror of the web's `useFormErrorFocus`. Null outside a Screen, and consumers
 * must treat null as "nothing to move".
 *
 * THE CONTEXT IS THE SECOND DOOR, NOT THE FIRST (forms-F4, 2026-09-05 audit).
 * It was the only one, and it reached nobody: every screen that calls
 * `useScrollToError` calls it from the component that RENDERS the Screen —
 * above the provider, where `useContext` answers null — so the hook never
 * scrolled once on any screen that used it. A context serves a consumer
 * nested INSIDE the Screen; the screens are all outside. `Screen` therefore
 * also accepts a `scrollRef` prop, which is what the hook hands back for the
 * caller to pass down. The context stays for the nested case.
 */
export const ScreenScrollContext = createContext<RefObject<ScrollView | null> | null>(null);

/**
 * The pull-to-refresh control for `Screen`, with this app's colours already on
 * it. Pass the result straight to `<Screen refreshControl={…}>`.
 *
 * WHY IT IS HERE. `Screen` has accepted `refreshControl` since it was written,
 * and seven list screens use it — each declaring the same four props with the
 * same accent colour, because there was nothing to call. Meanwhile FIVE detail
 * screens reached for a full-width button labelled "Actualizar" instead:
 * CredentialScreen, PetDocumentScreen, LibretaScreen, EventDetailScreen,
 * LostScreen. On the pet document that produced a hierarchy inversion worth
 * stating plainly — the only blue, full-width, primary-weight button on a
 * national credential said "reload".
 *
 * Reloading is not an action a document offers. It is a gesture the platform
 * already has, every Android user already knows, and it costs no pixels.
 *
 * The seven existing screens still inline their own copy; migrating them is
 * mechanical and deliberately not bundled with the credential work.
 */
export function pullToRefresh(onRefresh: () => void, refreshing: boolean) {
  return (
    <RefreshControl
      colors={[COLORS.accent]}
      onRefresh={onRefresh}
      refreshing={refreshing}
      tintColor={COLORS.accent}
    />
  );
}

/**
 * What `KeyboardAvoidingView` should DO on this platform.
 *
 * A PURE FUNCTION AND NOT AN INLINE TERNARY, so the rule is testable on the
 * platform the test is not running on. Jest runs this app on one `Platform.OS`;
 * the defect below was Android-only, and a rule that can only be asserted for
 * the platform the runner happens to be is a rule with half a test.
 *
 * THE ANDROID ARM WAS `undefined` UNTIL 2026-09-11, AND THAT IS A NO-OP —
 * literally. React Native's `KeyboardAvoidingView` switches on `behavior` and
 * its `default:` arm returns a plain `<View>` with the style and nothing else
 * (react-native 0.86.3, `Libraries/Components/Keyboard/KeyboardAvoidingView.js`
 * — the `switch (behavior)` at the foot of `render`). So sixteen screens passed
 * `keyboardAvoiding` and sixteen screens got a `View`. React Native's own docs
 * say it plainly: "on both iOS and Android, setting `behavior` is recommended".
 *
 * IT SURVIVED BECAUSE ANDROID USED TO COMPENSATE. With `adjustResize` and no
 * edge-to-edge, the WINDOW shrank for the IME and the ScrollView inside got a
 * smaller viewport for free. Expo SDK 54+ enforces edge-to-edge on Android, so
 * the window is no longer resized — the keyboard arrives as an inset and
 * nothing moves. The compensation left; the no-op stayed. (open-work row 11)
 *
 * `"height"` AND NOT `"padding"` ON ANDROID. Both are driven by the same
 * `keyboardDidShow` metrics, so this is not a correctness fork; `"height"` is
 * the arm that shrinks the avoiding view itself, which is what a full-screen
 * flex container wrapping a ScrollView wants — `"padding"` adds a bottom pad
 * INSIDE a box whose height never changed, which is the shape that double-counts
 * the moment anything upstream does resize the window again. It is also what
 * open-work row 11 prescribed after measuring this app under Expo 57.
 *
 * THE NATIVE HALF IS NOT TOUCHED AND DOES NOT NEED TO BE. `app.config.ts` sets
 * no `android.softwareKeyboardLayoutMode`, so it is Expo's default `"resize"`,
 * which is the value this arm wants. Changing it would move `runtimeVersion`'s
 * fingerprint and cost a build — there was nothing to change.
 */
export function keyboardAvoidingBehavior(os: typeof Platform.OS): "padding" | "height" {
  // ANDROID GETS `"height"`, AND THIS VALUE WAS ACCUSED AND ACQUITTED ON
  // 2026-09-11 — the record is here so nobody re-runs the trial.
  //
  // Build 11 shipped it and the app began closing whenever a keyboard was
  // involved. It was the obvious suspect: it is the one thing that changed what
  // happens when an IME appears, and it reaches all sixteen screens that ask for
  // keyboard avoidance. That reasoning was wrong twice over. There were six days
  // and 163 mobile files between builds 10 and 11, so "only one variable moved"
  // was never true; and the crash, pulled off the device over adb, was a
  // ClassCastException inside React Native's own `ReactEditText`, reached
  // through `onEditorAction` and gated on `submitBehavior` — see the note in
  // `TextField` below. Nothing to do with this function.
  //
  // Reverted here for an afternoon on that bad evidence, and restored once the
  // stack arrived. The defect it fixes is real: under Expo SDK 54+ Android is
  // edge-to-edge, the window no longer resizes for the IME, and `undefined`
  // renders a plain <View> that avoids nothing.
  return os === "ios" ? "padding" : "height";
}

export function Screen({
  children,
  edges = ["bottom"],
  keyboardAvoiding = false,
  refreshControl,
  gap = SPACE.lg,
  scrollRef: scrollRefProp,
}: {
  children: ReactNode;
  edges?: readonly Edge[];
  /** Set on screens with a text input the keyboard could cover. */
  keyboardAvoiding?: boolean;
  refreshControl?: ScrollViewProps["refreshControl"];
  gap?: number;
  /**
   * The ref `useScrollToError` returns, so a screen that calls the hook from
   * OUTSIDE its own Screen (every form screen does) can still reach the scroll
   * view. See `ScreenScrollContext`.
   */
  scrollRef?: RefObject<ScrollView | null>;
}) {
  const ownScrollRef = useRef<ScrollView>(null);
  const scrollRef = scrollRefProp ?? ownScrollRef;
  const scroll = (
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={[styles.scroll, { gap }]}
      // Native-feel audit (M10, 2026-09-24): tapping empty space or dragging
      // the list must close the keyboard, the way every native app on the
      // phone already does. `keyboardShouldPersistTaps="handled"` was already
      // here (so a tap that LANDS ON a button still fires the button instead
      // of only closing the keyboard — a tap the RN docs call "handled" is one
      // a child view's own responder claims); `keyboardDismissMode="on-drag"`
      // is the other half, for the gesture a tap can't cover.
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}
    >
      <ScreenScrollContext.Provider value={scrollRef}>{children}</ScreenScrollContext.Provider>
    </ScrollView>
  );

  return (
    <SafeAreaView style={styles.screen} edges={edges}>
      {keyboardAvoiding ? (
        <KeyboardAvoidingView style={styles.fill} behavior={keyboardAvoidingBehavior(Platform.OS)}>
          {scroll}
        </KeyboardAvoidingView>
      ) : (
        scroll
      )}
    </SafeAreaView>
  );
}

// ---------- Typography -----------------------------------------------------

/** The page title. IBM Plex Serif at the web's dominant display step (28px). */
export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

/** The line under a Title. See the deviation note in the header. */
export function Subtitle({ children }: { children: ReactNode }) {
  return <Text style={styles.subtitle}>{children}</Text>;
}

/**
 * The mono uppercase micro-label above a block. "Credencial pública",
 * "Paso 2 de 6". The web's eyebrow convention (`lint:eyebrow` fences its
 * pairing with a title there).
 */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

/**
 * The field label. Mono, uppercase, letterspaced, with the seal-red asterisk
 * when the field is required — the Libreta Nacional field anatomy, verbatim.
 *
 * The asterisk is `aria-hidden` on the web and its native equivalent here is
 * not to expose it at all: it is decoration, and the requiredness that matters
 * to a screen reader travels on the control's own `accessibilityLabel`.
 *
 * A SIBLING NODE, NOT A NESTED <Text> (CA-M3, 2026-09-05 audit). It was nested,
 * with the same two hiding flags — and React Native flattens nested text into
 * one native node on Android, so the flags on the inner span were lost and
 * TalkBack read "Nombre asterisco". Two Texts in a row keep two native nodes,
 * and the flags on the second one survive.
 *
 * THE LABEL SHRINKS AND THE ASTERISK DOES NOT, which is the price of that row.
 * Yoga defaults every child to `flexShrink: 0`, so a long required label
 * measures at its full intrinsic width and lays the asterisk out PAST the
 * parent's right edge — where it is clipped or drawn over the next control.
 * "¿QUÉ O A QUIÉN ESTÁS DENUNCIANDO?" (DenunciaScreen) is 33 characters drawn
 * uppercase in mono with letterspacing, and at the Android font scales this app
 * is expected to survive (≥ 1.3, measured on a device) it is wider than the
 * screen on its own. The label yields, the asterisk keeps its width, and the
 * label wraps instead of pushing the mark it is marked by out of the frame.
 */
export function FieldLabel({
  children,
  required = false,
}: {
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <View style={styles.fieldLabelRow}>
      <Text style={[styles.fieldLabel, styles.fieldLabelText]}>{children}</Text>
      {required ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={[styles.fieldLabel, styles.asterisk]}
        >
          *
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The control's accessible name.
 *
 * DERIVED FROM THE VISIBLE LABEL, and an explicit `accessibilityLabel` REPLACES
 * THE LABEL, NOT THE SUFFIX (CA-M1/CA-M2, 2026-09-05 audit). Before this, the
 * suffix was computed first and `...rest` spread after it, so any call site
 * that named its own label — the alta's "Nombre", the locality picker — wiped
 * ", obligatorio" along with it, and a screen reader on those fields heard no
 * requiredness at all. The suffix is a fact about the field; a caller may
 * rename the field, and may not make it optional by renaming it.
 */
function accessibleName(label: string, explicit: string | undefined, required: boolean): string {
  const name = explicit ?? label;
  return required ? `${name}, obligatorio` : name;
}

/**
 * A link out of a flow. Blue, underlined, and given a real touch target.
 *
 * `hitSlop` rather than padding: the web's links sit inline in a sentence and
 * padding would push the sentence apart, but a 10px-tall tap target on a phone
 * is a miss waiting to happen. Slop grows the target without moving the text.
 */
export function LinkText({
  children,
  onPress,
  accessibilityHint,
}: {
  children: ReactNode;
  onPress: () => void;
  accessibilityHint?: string;
}) {
  const slop = Math.round((TOUCH_TARGET - TYPE.md * LEADING.md) / 2);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint={accessibilityHint}
      android_ripple={RIPPLE_BORDERLESS}
      hitSlop={{ top: slop, bottom: slop, left: SPACE.sm, right: SPACE.sm }}
      onPress={onPress}
      style={pressedOpacity}
    >
      <Text style={styles.link}>{children}</Text>
    </Pressable>
  );
}

// ---------- Text field -----------------------------------------------------

export type TextFieldProps = Omit<TextInputProps, "style"> & {
  /** Renders the mono uppercase label above the control. */
  label: string;
  required?: boolean;
  /** Red border, matching the web's `aria-[invalid=true]` rule. */
  invalid?: boolean;
  /** Mono variant — codes, tokens, dates. */
  mono?: boolean;
  /** Ref to the underlying TextInput — return-key chains focus through it
   * (`useReturnKeyChain`). A dedicated prop rather than `ref` because this
   * component's own ref would name the wrapper View, not the input. */
  inputRef?: Ref<TextInput>;
};

/**
 * Spread onto a `TextField` that takes personal contact data the phone should
 * not REMEMBER: a bite victim's name and phone (a third party), a denunciante's
 * contact. Those stores outlive the app's own draft sweep and are beyond its
 * reach, so the only fix is not to feed them — and the two halves of that are
 * NOT equally complete, which is worth being exact about:
 *
 *   · AUTOFILL: the opt-out is complete. `autoComplete` + `importantForAutofill`
 *     keep the value out of Android's autofill service, and `textContentType`
 *     out of iOS's content-type suggestions.
 *   · KEYBOARD LEARNING: this only REDUCES it. `autoCorrect: false` stops most
 *     keyboards from offering and learning corrections, but the switch that
 *     actually forbids an Android IME from learning — `IME_FLAG_NO_PERSONALIZED_
 *     LEARNING`, the "incognito" flag — is not exposed by React Native's
 *     `TextInput`, so a keyboard that learns from everything it sees still can.
 *     Closing that needs a native change, not a prop.
 *
 * It says nothing about `keyboardType`/`inputMode` — a phone field keeps its
 * telephone keypad — and must be spread BEFORE any prop a call site wants to
 * win over it.
 */
export const NO_KEYBOARD_MEMORY = {
  autoCorrect: false,
  autoComplete: "off",
  importantForAutofill: "no",
  textContentType: "none",
} as const satisfies Partial<TextInputProps>;

/**
 * The Libreta Nacional control: white fill, warm border, 4px corners, and a
 * 3px celeste ring on focus.
 *
 * THE RING IS PADDING, NOT A BORDER, and that is the whole reason the wrapper
 * exists. The web draws it with `box-shadow: 0 0 0 3px`, which occupies no
 * layout. React Native has no equivalent that renders on Android, and growing
 * a border on focus would move the field 3px and shove the rest of the form
 * down every time the keyboard opens. So the wrapper always reserves the 3px
 * and only fills it when focused.
 *
 * THE ACCESSIBLE NAME IS DERIVED, NOT HOPED FOR. The visible label is a sibling
 * <Text>, which React Native does not associate with the input the way a
 * <label for> does on the web — so an unlabelled TextInput announces itself as
 * a bare "text field". It worked until now only because all eight call sites
 * happened to pass `accessibilityLabel` by hand: a convention, and a convention
 * is one forgetful call site away from a screen reader reading nothing.
 *
 * Deriving it also means the asterisk never reaches the name. `FieldLabel`
 * draws that mark as its own sibling <Text>, hidden from assistive tech — the
 * fix for the Android flattening that used to make TalkBack say "Nombre
 * asterisco" — and the derived name does not read the visual node at all: it
 * says ", obligatorio", which is the fact the asterisk stands for. Two
 * independent mechanisms for one requirement, which is what keeps a change to
 * the label's layout from changing what a screen reader hears.
 *
 * An explicit `accessibilityLabel` replaces the NAME and keeps the suffix —
 * see `accessibleName`.
 */
export function TextField({
  label,
  required = false,
  invalid = false,
  mono = false,
  onBlur,
  onFocus,
  inputRef,
  accessibilityLabel,
  ...rest
}: TextFieldProps) {
  // THE `submitBehavior` DEFAULT IS `"submit"`, AND IT IS A CRASH FIX, NOT A
  // PREFERENCE. Measured over adb from a Galaxy J7 (Android 8.1, API 27) on
  // 2026-09-11, twice, while the product owner tried to use the app:
  //
  //   java.lang.ClassCastException: ReactEditText cannot be cast to ViewGroup
  //     at ReactEditText.clearFocusAndMaybeRefocus(ReactEditText.kt:378)
  //     at ReactTextInputManager.addEventEmitters$lambda$3(...:936)
  //     at android.widget.TextView.onEditorAction(...)
  //
  // React Native's own code, and the condition is in the open:
  //
  //   if (SDK_INT > VERSION_CODES.P || !isInTouchMode) { super.clearFocus() }
  //   else { val rootViewGroup = rootView as ViewGroup   // <- throws }
  //
  // `P` is 28. On API 29+ the first arm runs and there is no cast; at 28 and
  // below the else-arm casts `rootView` and dies. `clearFocusAndMaybeRefocus`
  // is called from the editor-action listener, and ONLY when
  // `shouldBlurOnReturn()` is true — which is React Native's DEFAULT for every
  // single-line TextInput. So on Android 9 and older, every plain field in this
  // app closed the app when the person pressed the keyboard's own "Listo" key.
  //
  // `"submit"` dispatches the submit event and does not blur, so the broken
  // method is never reached. What it costs is that the keyboard stays open
  // after the key; the callers that want it closed say so themselves.
  //
  // PUT BEFORE `{...rest}` ON PURPOSE: a caller that passes its own
  // `submitBehavior` still wins. This is a floor, not a lock.
  //
  // AND IT IS SINGLE-LINE ONLY, which the first version of this fix got wrong
  // and shipped. `submitBehavior` was set unconditionally, and React Native's
  // own typing spells out the cost: for a MULTILINE input, `undefined` defaults
  // to `"newline"` and `"submit"` "will only send a submit event and not blur"
  // — so Enter stopped inserting a line break in all 26 multiline fields in
  // this app. Somebody writing a denuncia would have got one unbreakable
  // run-on paragraph.
  //
  // The regression bought nothing, which is the part worth remembering: the
  // crash is reached only through `shouldBlurOnReturn()`, and that is already
  // false for a multiline field. `use-return-key-chain.ts` states the same
  // invariant at its head — "a multiline field's return key types a newline,
  // that is its job" — and this change broke it globally while quoting it.
  //
  // Jest could not have caught it: no test asserts newline behaviour, and the
  // arm that breaks is native.
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <FieldLabel required={required}>{label}</FieldLabel>
      <View style={[styles.ring, focused ? styles.ringOn : null]}>
        <TextInput
          ref={inputRef}
          accessibilityLabel={accessibleName(label, accessibilityLabel, required)}
          placeholderTextColor={COLORS.inkFaint}
          // SINGLE-LINE ONLY — see the note above, and the correction below it.
          submitBehavior={rest.multiline ? undefined : "submit"}
          {...rest}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          style={[
            styles.input,
            mono ? styles.inputMono : null,
            focused ? styles.inputFocused : null,
            invalid ? styles.inputInvalid : null,
          ]}
        />
      </View>
    </View>
  );
}

/**
 * `TextField` for passwords, with the reveal toggle the web has had all along
 * (`LnPasswordInput`, components/ui/Field.tsx:433) — QOL audit 2026-09-01,
 * the PO's own first example. The toggle matters MOST off the login screen:
 * signup and reset type a NEW password blind, twice, and a typo there is a
 * lockout on a pilot where mail recovery is days old. Visibility is per-field
 * local state — revealing one field never reveals its sibling — and the
 * control owns `secureTextEntry`, so a caller cannot half-wire it.
 *
 * `inputRef` REACHES THE INPUT since M10 (2026-09-24) — it did not before.
 * The prop was already in the type (`Omit<TextFieldProps, …>` keeps it), so it
 * silently fell into `...rest` and landed on the `TextInput` as an unknown
 * prop instead of its `ref`. Harmless until `useReturnKeyChain` needed to
 * focus INTO a password field from the one before it — a login or signup form
 * chaining email → password could not, because there was nowhere for the
 * chain to send focus.
 */
export function PasswordField({
  label,
  required = false,
  invalid = false,
  onBlur,
  onFocus,
  inputRef,
  accessibilityLabel,
  ...rest
}: Omit<TextFieldProps, "mono" | "secureTextEntry">) {
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.field}>
      <FieldLabel required={required}>{label}</FieldLabel>
      <View style={[styles.ring, focused ? styles.ringOn : null, styles.passwordRow]}>
        <TextInput
          ref={inputRef}
          accessibilityLabel={accessibleName(label, accessibilityLabel, required)}
          placeholderTextColor={COLORS.inkFaint}
          submitBehavior="submit"
          {...rest}
          secureTextEntry={!visible}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          style={[
            styles.input,
            styles.passwordInput,
            focused ? styles.inputFocused : null,
            invalid ? styles.inputInvalid : null,
          ]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
          android_ripple={RIPPLE_BORDERLESS}
          onPress={() => setVisible((v) => !v)}
          style={({ pressed }) => [
            styles.passwordEye,
            pressed ? { opacity: PRESSED_OPACITY } : null,
          ]}
        >
          <Icon name={visible ? "ocultar" : "ver"} size="md" color={COLORS.inkFaint} />
        </Pressable>
      </View>
    </View>
  );
}

// ---------- Date and time fields -------------------------------------------

type MaskedFieldProps = Omit<
  TextFieldProps,
  "mono" | "inputMode" | "keyboardType" | "placeholder" | "maxLength" | "onChangeText"
> & {
  onChangeText: (value: string) => void;
};

export type DateFieldProps = MaskedFieldProps & {
  /**
   * The earliest day the native calendar offers. Pass it only where the SERVER
   * already refuses earlier days — the picker mirrors a rule, it never invents
   * one. The typed fallback is not bounded by it; the contract still judges.
   */
  minimumDate?: Date;
  /** The latest day the native calendar offers. Same discipline as `minimumDate`. */
  maximumDate?: Date;
};

/**
 * Whether the native dialog is the field's primary entry right now: Android,
 * and no screen reader running.
 *
 * TALKBACK GETS THE TYPED FIELD, NOT THE DIALOG. The masked number-pad entry is
 * the one path this kit has proven accessible — a labelled text input with a
 * spoken value — and it is what every screen had before the picker existed. A
 * modal calendar is a detour for a screen-reader user, so with TalkBack on the
 * field behaves exactly as it did before M18. The listener keeps that true when
 * TalkBack is switched on or off with the form already open.
 *
 * iOS keeps the typed field too: the app ships Android first, and iOS's picker
 * is an inline control rather than a dialog, which is a layout decision this
 * change does not make.
 */
function useNativePickerAvailable(): boolean {
  // UNKNOWN UNTIL ANSWERED, and unknown means the typed mask. Starting at
  // `false` drew the picker for one frame with TalkBack on — the wrong control,
  // announced first. A query that fails leaves it unknown, which is the safe arm.
  const [screenReader, setScreenReader] = useState<boolean | null>(null);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    let alive = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (alive) setScreenReader(enabled);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("screenReaderChanged", (enabled) => {
      if (alive) setScreenReader(enabled);
    });
    return () => {
      alive = false;
      subscription?.remove();
    };
  }, []);
  return Platform.OS === "android" && screenReader === false;
}

/**
 * The vertical slop that grows "Escribir la fecha" to a full `TOUCH_TARGET` —
 * `LinkText`'s arithmetic, over this link's smaller type. The link's
 * `marginTop` is the same number, so the grown target ends where the input
 * begins instead of stealing the bottom of its tap area.
 */
const FIELD_ACTION_SLOP = Math.ceil((TOUCH_TARGET - TYPE.sm * LEADING.sm) / 2);

/** Hand one TextInput to both the caller's ref and the field's own. */
function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref !== null && ref !== undefined) (ref as { current: T | null }).current = value;
}

function clampDate(date: Date, min: Date | undefined, max: Date | undefined): Date {
  if (min !== undefined && date.getTime() < min.getTime()) return new Date(min.getTime());
  if (max !== undefined && date.getTime() > max.getTime()) return new Date(max.getTime());
  return date;
}

/**
 * The masked text field, with the native Android dialog in front of it.
 *
 * ONE TEXT INPUT IN BOTH MODES, and that is what keeps the API — and every
 * caller's tests — unchanged: the accessible name, the value, `onChangeText`,
 * `inputRef` and the return-key chain all land on the same `TextInput` as
 * before. What the picker mode changes is only what a TAP does: the soft
 * keyboard is suppressed (`showSoftInputOnFocus={false}`) and `onPress`
 * opens the dialog instead — a completed tap, never `onPressIn`, which fired
 * on the first touch of a SCROLL that happened to start on a date field.
 *
 * FOCUS THAT ARRIVES WITHOUT A TAP closes the keyboard and opens nothing. The
 * return-key chain ("Siguiente" on the field above) focuses this input with
 * the keyboard still up; with the soft input suppressed and the caret hidden,
 * that left a keyboard typing into a field showing no cursor. A dialog popping
 * open on a key press would be the other wrong answer, so it waits for a tap. A selection is written through the same
 * `onChangeText` the typed path uses, as the same masked string, so the
 * caller's state cannot tell which door the value came through. A cancel
 * writes nothing.
 *
 * THE TYPED PATH IS ONE TAP AWAY, always: "Escribir la fecha" under the field
 * flips it back to the number-pad mask for this field, and "Elegir en el
 * calendario" flips it forward again. Somebody whose birthday list lives in
 * their head types faster than they scroll a calendar back forty years.
 */
function PickerMaskedField({
  mode,
  onChangeText,
  mask,
  placeholder,
  maxLength,
  minimumDate,
  maximumDate,
  inputRef,
  ...rest
}: MaskedFieldProps & {
  mode: "date" | "time";
  mask: (text: string) => string;
  placeholder: string;
  maxLength: number;
  minimumDate?: Date;
  maximumDate?: Date;
}) {
  const pickerAvailable = useNativePickerAvailable();
  const [typing, setTyping] = useState(false);
  const ownRef = useRef<TextInput | null>(null);
  const picking = pickerAvailable && !typing;
  const editable = rest.editable !== false;

  const openPicker = () => {
    const now = new Date();
    const current =
      mode === "date"
        ? dateInputToLocalDate(rest.value ?? "")
        : timeInputToLocalDate(rest.value ?? "", now);
    const fallback =
      mode === "date" ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12) : now;
    DateTimePickerAndroid.open({
      mode,
      value:
        mode === "date"
          ? clampDate(current ?? fallback, minimumDate, maximumDate)
          : (current ?? fallback),
      is24Hour: true,
      ...(mode === "date" && minimumDate !== undefined ? { minimumDate } : {}),
      ...(mode === "date" && maximumDate !== undefined ? { maximumDate } : {}),
      // Monday first, as an Argentine calendar prints it. Month and day names
      // come from the DEVICE locale: Android's dialog takes no locale of its own.
      ...(mode === "date" ? { firstDayOfWeek: 1 as const } : {}),
      positiveButton: { label: "Aceptar" },
      negativeButton: { label: "Cancelar" },
      // A dialog that cannot open (no activity, a vendor ROM refusing it) must
      // not leave the field unusable: drop to the typed mask.
      onError: () => setTyping(true),
      onValueChange: (_event, selected) => {
        if (selected === undefined) return;
        onChangeText(
          mode === "date" ? localDateToDateInput(selected) : localDateToTimeInput(selected),
        );
      },
    });
  };

  const noun = mode === "date" ? "la fecha" : "la hora";
  return (
    <View style={styles.field}>
      <TextField
        mono
        inputMode="numeric"
        placeholder={placeholder}
        maxLength={maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={(text) => onChangeText(mask(text))}
        {...rest}
        inputRef={(node: TextInput | null) => {
          ownRef.current = node;
          assignRef(inputRef, node);
        }}
        {...(picking
          ? {
              showSoftInputOnFocus: false,
              caretHidden: true,
              accessibilityHint: `Abre el ${mode === "date" ? "calendario" : "reloj"}`,
              onPress: (e: GestureResponderEvent) => {
                rest.onPress?.(e);
                if (editable) openPicker();
              },
              onFocus: (e: Parameters<NonNullable<TextInputProps["onFocus"]>>[0]) => {
                Keyboard.dismiss();
                rest.onFocus?.(e);
              },
            }
          : {})}
      />
      {pickerAvailable && editable ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={{
            top: FIELD_ACTION_SLOP,
            bottom: FIELD_ACTION_SLOP,
            left: SPACE.sm,
            right: SPACE.sm,
          }}
          onPress={() => {
            if (typing) {
              setTyping(false);
              ownRef.current?.blur();
              openPicker();
            } else {
              setTyping(true);
              // After the re-render that turns the keyboard back on.
              setTimeout(() => ownRef.current?.focus(), 0);
            }
          }}
          style={(s) => [styles.fieldAction, pressedOpacity(s)]}
        >
          <Text style={styles.fieldActionText}>
            {typing
              ? `Elegir en el ${mode === "date" ? "calendario" : "reloj"}`
              : `Escribir ${noun}`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * A calendar day, stored as `DD/MM/AAAA` — picked from the native Android
 * calendar, or typed off a number pad.
 *
 * THE NATIVE PICKER ARRIVED IN M18 (native build of 2026-10-01), behind the
 * same props. This comment used to say the kit had no date picker because
 * "adding a native one is a dependency decision that does not belong in a
 * hotfix"; that decision has now been made, as a native release rather than a
 * hotfix, with `@react-native-community/datetimepicker` at the version SDK 57
 * pins. On Android with no screen reader, tapping the field opens the
 * calendar; "Escribir la fecha" under it returns to the typed mask, and with
 * TalkBack on the field is the typed mask only (see `useNativePickerAvailable`).
 *
 * THE STORED STRING DID NOT CHANGE. Both paths hand `onChangeText` the same
 * `DD/MM/AAAA` (forms-F1/F2, 2026-09-05 audit: the format every Argentine form
 * asks for, not the wire's `AAAA-MM-DD`), and `dateInputToIso` in
 * `date-input.ts` still converts at the view-model boundary. The contract
 * remains the judge; `minimumDate`/`maximumDate` only keep the calendar from
 * OFFERING a day the server would refuse.
 *
 * The mask is applied on the way IN (`onChangeText`), so the caller's state and
 * the field's `value` agree — a caller that stored the unmasked keystrokes would
 * render a field that fights its own controlled value.
 */
export function DateField({ minimumDate, maximumDate, ...rest }: DateFieldProps) {
  return (
    <PickerMaskedField
      mode="date"
      mask={maskDateInput}
      placeholder="DD/MM/AAAA"
      maxLength={10}
      minimumDate={minimumDate}
      maximumDate={maximumDate}
      {...rest}
    />
  );
}

/**
 * A wall-clock time stored as `HH:MM` — the native 24-hour clock, or typed.
 * Same two paths and the same fallback discipline as `DateField`.
 */
export function TimeField(props: MaskedFieldProps) {
  return (
    <PickerMaskedField
      mode="time"
      mask={maskTimeInput}
      placeholder="HH:MM"
      maxLength={5}
      {...props}
    />
  );
}

// ---------- Choice ---------------------------------------------------------

/**
 * A one-of-N chooser, in the same field anatomy `TextField` uses.
 *
 * PROMOTED FROM `RecordEventScreen` (WU-O), on that file's own instruction. It
 * lived there as a local component whose docblock said: "LOCAL TO THIS SCREEN
 * rather than promoted into `kit.tsx`: it has exactly one consumer, and a
 * primitive with one caller is a guess about the second. It moves the day a
 * second screen needs it." The transfer form is the second screen — it picks one
 * of four reasons — so it moved, rather than being copied with a comment
 * explaining why there are now two.
 *
 * `accessibilityRole="radio"` inside a `radiogroup` is what a screen reader
 * needs to announce the set AS A SET rather than as loose buttons, and it is why
 * this is not four `SecondaryButton`s with a tick in the label: that spelling
 * looks selected and announces nothing.
 *
 * NOTHING IS PRESELECTED unless the caller passes a `selected` value. On a form
 * that hands over an animal, a default is a choice somebody did not make.
 */
export function Choice<T extends string>({
  label,
  required = false,
  options,
  selected,
  optionLabel,
  onSelect,
  disabled = false,
}: {
  label: string;
  required?: boolean;
  options: readonly T[];
  selected: T | null;
  optionLabel: (value: T) => string;
  onSelect: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.choiceField}>
      <FieldLabel required={required}>{label}</FieldLabel>
      {/* THE GROUP CARRIES THE QUESTION. `FieldLabel` above is a sibling, not a
          binding: a screen reader walking chip by chip announces "Sí, radio
          button, checked" with nothing saying WHICH question that answers. It
          was invisible while every form had at most one yes/no row; the
          fallecimiento form has three on one screen — "¿falleció en una
          veterinaria?", "¿lo confirmó un veterinario?", "¿crematorio privado?"
          — and three identical pairs of chips is when the omission becomes a
          person unable to fill in the form. */}
      <View style={styles.choiceRow} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((option) => {
          const active = option === selected;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ checked: active, disabled }}
              android_ripple={RIPPLE}
              disabled={disabled}
              onPress={() => {
                // M10 (native-feel audit, 2026-09-24): picking a chip must
                // close the keyboard the same way the two BreedPickers already
                // did locally (M6) — here ONCE, in the shared primitive, so
                // every screen with a `Choice` (and every future one) gets it
                // for free instead of copying the same three lines in again.
                Keyboard.dismiss();
                onSelect(option);
              }}
              style={[styles.chip, active ? styles.chipActive : null]}
            >
              <Text style={active ? styles.chipLabelActive : styles.chipLabel}>
                {optionLabel(option)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ---------- Buttons --------------------------------------------------------

/**
 * `active:scale-[0.98] active:opacity-90` on the web, for touch feedback.
 *
 * EXPORTED since 2026-09-03, and the reason is a measurement. The app holds 36
 * `<Pressable` JSX tags in NON-TEST files, counted at the tree this export
 * landed on; before this export, FIVE gave any visual response to a touch,
 * and all five were inside this file and `components.tsx`. The other 31 — the
 * credential's own action row included — were visually inert under a thumb,
 * because this helper existed and could not be reached from a screen. A
 * control that does not acknowledge a press is indistinguishable from a dead
 * one, which is exactly how the "Anotar" pill was reported on 2026-09-03: not
 * as "wrong", as *missing its event catcher*.
 *
 * Pass it straight to `style`, and add the static styles in the returned
 * array: `style={(s) => [styles.thing, pressedOpacity(s)]}`.
 */
export function pressedOpacity({ pressed }: PressableStateCallbackType) {
  return pressed ? { opacity: PRESSED_OPACITY } : null;
}

/**
 * Android's OWN press feedback, next to `pressedOpacity`'s iOS-flavoured fade
 * (Native-feel audit, 2026-09-24). `pressedOpacity` already renders on
 * Android — `Pressable` applies whatever `style` returns on either platform —
 * but a fade is not what Android calls acknowledging a touch: Material's own
 * affordance is a ripple, drawn by the platform itself the moment
 * `android_ripple` is set, and ignored outright on iOS, so passing it
 * everywhere costs iOS nothing.
 *
 * BOUNDED vs BORDERLESS is not a look, it is what the finger is actually on.
 * `RIPPLE` clips to the pressable's own box — right for anything with a
 * visible edge of its own: a row, a chip, a bordered button. `RIPPLE_BORDERLESS`
 * draws past those bounds in a soft circle — right for a control with NO
 * background of its own, like an icon toggle or an inline link, where a
 * clipped ripple would look like a rectangle bitten out of the icon's corner.
 * `RIPPLE_ON_FILL` is the same shape as `RIPPLE`, translucent WHITE instead —
 * for a control whose own fill is already a saturated colour (`PrimaryButton`),
 * where the pale tint the other two reuse would vanish into it.
 *
 * COLOUR IS A TOKEN, not an invented value. `RIPPLE`/`RIPPLE_BORDERLESS` reuse
 * `COLORS.focusRing` — the same fill `chipActive` and the focused field's ring
 * already wear for "this is the active/selected one" — so Android's own
 * built-in feedback is drawn in the same palette as everything else in this
 * kit that already means the same thing. `RIPPLE_ON_FILL`'s white cannot be:
 * no token IS a translucent colour (every one of them is an opaque hex), and a
 * ripple is the one place this file needs partial opacity to read as a ripple
 * rather than a flash — the same reasoning `TopLevelNavMenu`'s dim overlay and
 * `DocumentChromeNative`'s band-chip fill already argue for their own derived
 * `rgba(...)` literals.
 */
export const RIPPLE: PressableAndroidRippleConfig = { color: COLORS.focusRing };
export const RIPPLE_BORDERLESS: PressableAndroidRippleConfig = {
  color: COLORS.focusRing,
  borderless: true,
};
export const RIPPLE_ON_FILL: PressableAndroidRippleConfig = { color: "rgba(255, 255, 255, 0.28)" };

/**
 * A row that is a destination, or a row that explains why it is not one.
 *
 * WHY THIS IS IN THE KIT NOW. Until 2026-09-03 this file offered exactly two
 * controls — `PrimaryButton` and `SecondaryButton`, both full-width stretched
 * pills — and nothing else. Every screen that needed a *row* rather than a
 * call-to-action invented one, and at least six private shapes existed:
 * `PetRow` (app/mascotas/index.tsx — outside src/, which is why an rg over
 * src/ alone reads as if it were gone), `EntryCard` (pets/LibretaScreen.tsx),
 * `MoreRow` (pets/OwnerFace.tsx), and the hand-rolled pressables in
 * TurnosScreen, TransfersScreen and NotificationsScreen. The kit was a form
 * system pretending to be a design system, and the divergence it produced is
 * what the 2026-09-03 review reported as separate defects.
 *
 * THE INERT VARIANT IS THE POINT, not an afterthought. Omitting `onPress`
 * gives a row that renders in the same shape, states `disabled` to the
 * accessibility layer, and carries a `caption` saying why — the doctrine this
 * app already follows ("controls without a native destination are drawn
 * disabled, not omitted"). Before this existed, `RecordEventScreen` needed
 * that shape for "Terminar una medicación", found no such primitive, and
 * reached for a `Card` — so one entry in a list of eleven pills rendered as a
 * bordered information box. That is the whole of the "se ve diferente, como en
 * una caja" report: not a styling mistake, a missing primitive.
 */
export function ListRow({
  label,
  caption,
  accessibilityHint,
  onPress,
}: {
  label: string;
  caption?: string;
  accessibilityHint?: string;
  onPress?: () => void;
}) {
  const isInert = onPress === undefined;
  // M10 (native-feel audit, 2026-09-24): a row is a destination — tapping one
  // must not leave a keyboard open over wherever it goes next. Dismissing here,
  // once, is the shared-primitive half of the same fix `Choice` gets below;
  // `Keyboard.dismiss()` is a no-op when nothing is up, so this costs nothing
  // on the rows that never had a keyboard to begin with.
  const handlePress = isInert
    ? undefined
    : () => {
        Keyboard.dismiss();
        onPress();
      };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isInert }}
      android_ripple={RIPPLE}
      disabled={isInert}
      onPress={handlePress}
      style={(state) => [styles.listRow, pressedOpacity(state)]}
    >
      {/* LABEL ABOVE CAPTION, always in a column — see `listRowText`. The
          column is rendered whether or not there is a caption so the row's
          anatomy does not change shape with its content, and so a trailing
          element (a chevron, a value) can be added beside it later without
          moving the text. */}
      <View style={styles.listRowText}>
        <Text style={isInert ? styles.listRowLabelMuted : styles.listRowLabel}>{label}</Text>
        {/* Two lines is a HEIGHT CAP, not the wrap: at the column's full width
            the 90-character RecordEventScreen caption fits in two lines at
            TYPE.sm, and the cap is what keeps a list of rows reading as a list
            instead of as a page of paragraphs. */}
        {caption === undefined ? null : (
          <Text numberOfLines={2} style={styles.listRowCaption}>
            {caption}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export type ButtonTone = "primary" | "seal";

/**
 * The primary action. Solid institutional blue, white label, pill.
 *
 * `tone="seal"` is the destructive twin — `LnButton`'s `seal` variant, which is
 * the red the web reserves for actions that end something.
 *
 * A-3 (M7 accessibility pass, fresh-review follow-up 2026-09-24). DISABLED
 * USED TO BE "the same button at 60% opacity" — `LnButton`'s
 * `disabled:opacity-60`, deliberately not grey, because a grey fill read as a
 * DIFFERENT button. That was wrong twice over, not once. First measured: white
 * text and `COLORS.accent` fill composited to 2.94–2.99:1 on the app's real
 * surfaces, under the 3:1 floor for a UI component (WCAG 1.4.11) — opacity
 * fades the WHOLE element, so the RATIO between text and fill collapses even
 * though neither colour is individually hard to see (the same lesson
 * `globals.css`'s hover-trio comment already recorded for the web). The first
 * fix (darkening the fill to `accentPressed` before fading) treated that as
 * the whole bug. It was not: on ANDROID, RN only composites a `View`'s
 * children as one unit when `needsOffscreenAlphaCompositing` is set on it,
 * which this control never did — absent that, the platform applies `opacity`
 * PER CHILD instead of to the rendered result, so the white label and the blue
 * fill each fade toward the page INDEPENDENTLY rather than together. Measured
 * that way the label can land near 2.2:1, further under floor than the
 * un-offset math predicted, and no amount of choosing a darker STARTING fill
 * fixes a per-child composite — the opacity itself is the defect.
 *
 * DISABLED NOW HAS NO OPACITY AT ALL. `buttonPrimaryDisabled` is an EXPLICIT
 * fill/text pair, both fully opaque: `COLORS.celeste` (the design system's
 * own lighter, less saturated blue — "links and informational accents", never
 * invented for this) under the SAME white label the enabled button wears.
 * Still visibly blue, so it reads as THIS button rather than a different one;
 * visibly SOFTER than `COLORS.accent`, so it reads as unavailable without
 * fading anything. Measured: white-on-celeste 3.15:1, celeste-on-white-card
 * 3.15:1, celeste-on-cream-canvas 3.01:1 — every pairing this control can
 * actually sit on clears 3:1 on its own, with nothing left to composite.
 * `accessibilityState` still carries the fact to a screen reader.
 *
 * `tone="seal"` keeps the old opacity-60 disabled treatment — untouched here;
 * it was not in scope for this pass.
 * `apps/mobile/src/ui/button-disabled-contrast.test.ts` renders the actual
 * disabled control and computes the ratio from ITS OWN resolved styles, not
 * from the tokens in isolation, so a regression back to opacity fails it.
 */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  tone = "primary",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: ButtonTone;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      android_ripple={RIPPLE_ON_FILL}
      disabled={disabled}
      onPress={onPress}
      style={(state) => [
        styles.button,
        tone === "seal" ? styles.buttonSeal : styles.buttonPrimary,
        disabled && tone === "primary" ? styles.buttonPrimaryDisabled : null,
        disabled && tone === "seal" ? styles.buttonDisabled : null,
        disabled ? null : pressedOpacity(state),
      ]}
    >
      <Text style={styles.buttonLabelOnFill}>{label}</Text>
    </Pressable>
  );
}

/**
 * The outline button — `LnButton`'s `ghost` variant. White fill, warm border,
 * ink label. "Volver", "Cancelar", "Ajustes".
 *
 * Its DISABLED state is not the primary's. A ghost button at 60% opacity is
 * nearly invisible on cream, so disabled here drops the fill and mutes the
 * label, which is exactly how the web draws its one permanently-disabled
 * button (the Mi Argentina stub: border, muted text, no fill).
 *
 * THE ANNOUNCED STATE IS THE COMPUTED ONE. This button is inert when `disabled`
 * is true OR when no `onPress` was given — the second case is how the Mi
 * Argentina placeholder is built — but `accessibilityState` used to report the
 * PROP alone. A button with no handler therefore looked disabled, behaved
 * disabled, and announced itself as available: a screen-reader user was invited
 * to press the one control on the screen that does nothing. One expression now
 * feeds the behaviour, the styling and the announcement, so the three cannot
 * disagree.
 */
export function SecondaryButton({
  label,
  onPress,
  disabled = false,
  accessibilityHint,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const isInert = disabled || onPress === undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isInert }}
      android_ripple={RIPPLE}
      disabled={isInert}
      onPress={onPress}
      style={(state) => [
        styles.button,
        styles.buttonGhost,
        isInert ? styles.buttonGhostDisabled : pressedOpacity(state),
      ]}
    >
      <Text style={isInert ? styles.buttonLabelMuted : styles.buttonLabelInk}>{label}</Text>
    </Pressable>
  );
}

// ---------- Callout --------------------------------------------------------

export type CalloutTone = "neutral" | "ok" | "warn" | "err";

/**
 * The bordered notice block the web login uses for every account-state message.
 *
 * A NOTE ON `neutral`. The web's two neutral notices (shift ended, sessions
 * revoked) render `bg-[var(--color-ln-paper-2)]`. When this was written that
 * custom property was declared NOWHERE, so those blocks drew with no background
 * at all and this used `stripe` rather than guess at a value. The token is now
 * declared (#f8f7f1, paper's slightly-darker sibling) and fenced by
 * lint:token-parity, so `neutral` binds to the real thing: the same notice reads
 * the same on both platforms, which is the point of the token package.
 */
export function Callout({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: CalloutTone;
  title?: string;
}) {
  return (
    <View
      // The err tone announces itself (QOL 2026-09-01): the web's error
      // surfaces carry role="alert" (Alert.tsx:18) so a screen reader hears a
      // failed submit immediately — without this, a TalkBack user had to
      // explore the screen to discover WHY nothing happened. Android reads the
      // live region; iOS reads the alert role. Non-error tones stay silent:
      // announcing an informational callout on mount is noise.
      accessibilityLiveRegion={tone === "err" ? "assertive" : undefined}
      accessibilityRole={tone === "err" ? "alert" : undefined}
      style={[styles.callout, CALLOUT_TONE[tone].box]}
    >
      {title === undefined ? null : (
        <Text style={[styles.calloutTitle, CALLOUT_TONE[tone].title]}>{title}</Text>
      )}
      {children}
    </View>
  );
}

// ---------- Divider --------------------------------------------------------

/** The web login's rule-word-rule separator: `──── o ────`. */
export function LabelledDivider({ label }: { label: string }) {
  return (
    <View style={styles.divider}>
      <View style={styles.dividerRule} />
      <Text style={styles.dividerLabel}>{label}</Text>
      <View style={styles.dividerRule} />
    </View>
  );
}

// ---------- Styles ---------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.canvas },
  fill: { flex: 1 },
  scroll: { padding: SPACE.xl2 },

  title: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.xl3,
    lineHeight: TYPE.xl3 * LEADING.xl2,
    letterSpacing: TYPE.xl3 * TRACKING.tight,
    color: COLORS.ink,
  },
  subtitle: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.inkSoft,
  },
  eyebrow: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * LABEL_TRACKING_EM,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
  // The label and its asterisk sit in one row so the asterisk can be its own
  // native node (see FieldLabel). The gap is the space the old `" *"` took.
  fieldLabelRow: { flexDirection: "row", alignItems: "baseline", marginBottom: SPACE.xs + 2 },
  fieldLabel: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * LABEL_TRACKING_EM,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
  /**
   * The label's share of the row: it SHRINKS, so a label wider than the screen
   * wraps instead of pushing the asterisk out of the container. Separate from
   * `fieldLabel` because the asterisk wears that same typography and must NOT
   * shrink — see FieldLabel.
   */
  fieldLabelText: { flexShrink: 1 },
  asterisk: { color: COLORS.seal, marginLeft: SPACE.xs, flexShrink: 0 },
  link: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.accent,
    textDecorationLine: "underline",
  },

  field: { alignSelf: "stretch" },
  fieldAction: { alignSelf: "flex-start", marginTop: FIELD_ACTION_SLOP },
  fieldActionText: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.accent,
    textDecorationLine: "underline",
  },

  // Choice — the chip row, moved here with the component (WU-O).
  choiceField: { alignSelf: "stretch", gap: SPACE.xs },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm },
  chip: {
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: RADIUS.chip,
    backgroundColor: COLORS.surface,
    paddingHorizontal: SPACE.md,
  },
  chipActive: { borderColor: COLORS.accent, backgroundColor: COLORS.focusRing },
  chipLabel: { fontFamily: FONTS.sans, fontSize: TYPE.md, color: COLORS.ink },
  chipLabelActive: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md, color: COLORS.accent },

  // The 3px the focus ring will occupy, reserved always so focusing a field
  // never reflows the form. See the note on TextField.
  ring: { padding: 3, margin: -3, borderRadius: RADIUS.control + 3 },
  ringOn: { backgroundColor: COLORS.focusRing },
  input: {
    minHeight: TOUCH_TARGET,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.surface,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm + 2,
    fontFamily: FONTS.sans,
    // 16px, and not only for the scale: it is the floor that stops iOS Safari
    // auto-zooming a focused field, which the web control carries for the same
    // reason (Wave 2 Item 9).
    fontSize: TYPE.base,
    color: COLORS.ink,
  },
  inputMono: { fontFamily: FONTS.mono, letterSpacing: TYPE.base * TRACKING.wide },
  // PasswordField: the input yields the ring's right edge to the eye toggle.
  //
  // `stretch`, NOT `center` (B-08, measured on build 10 at font scale 1.5, shot
  // 157): the e-mail field grew to 54.9dp and the password field beside it
  // stayed at 44.6dp, because `center` sizes each child by its own content and
  // the row then took the eye toggle's `minHeight: TOUCH_TARGET` as the answer —
  // so the toggle, a 44pt tap target, was capping the height of the text the
  // person was typing. `stretch` makes the row as tall as its tallest child (the
  // input, once its text scales) and grows the toggle to match. The icon stays
  // centred inside the toggle, which has its own `alignItems`/`justifyContent`.
  passwordRow: { flexDirection: "row", alignItems: "stretch" },
  passwordInput: { flex: 1 },
  passwordEye: {
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  inputFocused: { borderColor: COLORS.accent },
  inputInvalid: { borderColor: COLORS.danger },

  button: {
    minHeight: TOUCH_TARGET,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: RADIUS.button,
    paddingHorizontal: SPACE.lg + 2,
    paddingVertical: SPACE.sm + 2,
  },
  buttonPrimary: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  /** A-3: the disabled PRIMARY state, fully opaque — no `opacity`, see
   *  `PrimaryButton`'s docblock for why (Android composites `opacity` per
   *  child without `needsOffscreenAlphaCompositing`, so a faded fill and a
   *  faded label do not fade TOGETHER). `COLORS.celeste` clears 3:1 against
   *  both the white label on it and the app's surfaces under it, on its own. */
  buttonPrimaryDisabled: {
    backgroundColor: COLORS.celeste,
    borderColor: COLORS.celeste,
  },
  buttonSeal: { backgroundColor: COLORS.seal, borderColor: COLORS.seal },
  buttonGhost: { backgroundColor: COLORS.surface, borderColor: COLORS.borderStrong },
  // ListRow. Lifted verbatim from OwnerFace's private `MoreRow`, because a
  // refactor that also restyles is two changes wearing one commit.
  //
  // THAT "changes nothing visually" IS NO LONGER TRUE, and saying so is the
  // point of keeping the sentence. The captioned rows in OwnerFace's ⋯ Más
  // list ("Chapa física · Disponible en la web", "Viaje y movilidad ·
  // Próximamente") now stack instead of sitting beside their label. It is not a
  // regression: `Acompañamiento de adopción` + `Disponible en la web` measured
  // ~317 points side by side against a row budget of ~288, so that row was
  // already overflowing — the promotion did not restyle those rows, it exposed
  // what they had been doing. See `listRowText` for why the column won.
  listRow: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACE.md,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.canvas2,
  },
  /**
   * THE COLUMN IS THE BOUND, and neither Text is. Two facts decide this shape.
   *
   * First the RN one: `flexShrink` defaults to 0, and `listRow` is
   * `flexDirection: "row"` — a Text with an intrinsic width wider than what the
   * row has left does NOT wrap, it overflows the row's right edge in silence.
   * That is what the 90-character RecordEventScreen caption did on 2026-09-03.
   * Something in the row has to be allowed to give way.
   *
   * Second, WHICH something. Making both Texts shrinkable was the first fix and
   * it was wrong: Yoga hands out the negative space in proportion to each
   * child's basis, so the LABEL gives up ~66 points and "Terminar una
   * medicación" — the row's primary text, the thing a person is looking for —
   * wraps to two lines. The label styles below therefore carry NO `flexShrink`,
   * deliberately, exactly as `components.tsx`'s `row`/`rowLabel`/`rowValue`
   * already decided it (the value shrinks, the label does not).
   *
   * And side by side is not enough even with the caption bounded: it leaves the
   * caption ~108 points, about 17 characters a line, so two lines show ~34 of
   * the 90 — the sentence that says where the real control lives, truncated.
   * So the two stack, and this column takes the shrink for both of them.
   */
  listRowText: { flexShrink: 1, gap: 2 },
  listRowLabel: { fontFamily: FONTS.sansMedium, fontSize: TYPE.md, color: COLORS.ink },
  listRowLabelMuted: { fontFamily: FONTS.sans, fontSize: TYPE.md, color: COLORS.inkMuted },
  listRowCaption: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    // A caption that is allowed to wrap needs a line height; without one the
    // second line sits on the first. `body` in components.tsx sets it the same
    // way, off the shared LEADING scale.
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkFaint,
  },
  buttonDisabled: { opacity: DISABLED_OPACITY },
  buttonGhostDisabled: { backgroundColor: "transparent" },
  buttonLabelOnFill: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.md,
    color: COLORS.surface,
  },
  buttonLabelInk: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md, color: COLORS.ink },
  buttonLabelMuted: { fontFamily: FONTS.sans, fontSize: TYPE.md, color: COLORS.inkMuted },

  callout: {
    borderWidth: 1,
    borderRadius: RADIUS.control,
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.md,
    gap: SPACE.sm,
  },
  calloutTitle: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md },

  divider: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
  dividerRule: { flex: 1, height: 1, backgroundColor: COLORS.border },
  dividerLabel: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
});

/** Tone → the box and title colours. Kept out of `styles` so it can be indexed. */
const CALLOUT_TONE: Record<
  CalloutTone,
  { box: { backgroundColor: string; borderColor: string }; title: { color: string } }
> = {
  neutral: {
    box: { backgroundColor: COLORS.canvas2, borderColor: COLORS.border },
    title: { color: COLORS.ink },
  },
  ok: {
    box: { backgroundColor: COLORS.okSurface, borderColor: COLORS.okBorder },
    title: { color: COLORS.okInk },
  },
  warn: {
    box: { backgroundColor: COLORS.warnSurface, borderColor: COLORS.warnBorder },
    title: { color: COLORS.warnInk },
  },
  err: {
    box: { backgroundColor: COLORS.dangerSurface, borderColor: COLORS.dangerBorder },
    title: { color: COLORS.danger },
  },
};
