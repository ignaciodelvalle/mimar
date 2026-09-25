// The kit's own primitives, rendered — the FIRST test of this file, and the
// gap is the point.
//
// `kit.tsx` is the design system every screen is built out of, and until
// 2026-09-03 nothing rendered it: `PasswordField.test.tsx` covers one control
// and the rest were proven only by the screens that happened to use them. A
// primitive with no test of its own exports whatever its last caller tolerated.
//
// WHAT IS PINNED HERE, AND WHY EACH ONE:
//
//   · `ListRow`'s two arms. The live row fires and announces enabled; the
//     inert row renders the same shape, announces disabled, and CARRIES ITS
//     CAPTION — the caption is the sentence that says where the real control
//     lives, so a row that dropped it would be a dead control with no reason.
//   · The caption's BOUND, and WHERE it lives. React Native's `flexShrink`
//     defaults to 0 and the row is `flexDirection: "row"`, so a caption Text
//     with intrinsic width does not wrap — it runs past the row's right edge.
//     That was reported on 2026-09-03 against RecordEventScreen's
//     90-character caption, and it is a property of the primitive rather than
//     of that screen. The bound is the COLUMN that holds both Texts, and the
//     asymmetry is pinned in both directions: the column shrinks, the label
//     must not. Letting the label shrink too was the first fix and it wraps
//     "Terminar una medicación" — the row's primary text — so a later
//     "helpful" flexShrink on the label has to fail here.
//   · `pullToRefresh` as a pure element factory: the props it puts on the
//     control, and that the control actually reaches the Screen's scroll view.
//     Five detail screens replaced an "Actualizar" button with this gesture; if
//     the factory stopped wiring `onRefresh`, every one of them would look fine
//     and refresh nothing.
//
// jest has no Yoga, so nothing here measures a pixel. What it asserts is the
// style CONTRACT — the properties layout is computed from.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import {
  AccessibilityInfo,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  processColor,
} from "react-native";

import {
  Choice,
  DateField,
  FieldLabel,
  LinkText,
  ListRow,
  PasswordField,
  PrimaryButton,
  RIPPLE,
  RIPPLE_BORDERLESS,
  RIPPLE_ON_FILL,
  Screen,
  SecondaryButton,
  TextField,
  TimeField,
  keyboardAvoidingBehavior,
  pullToRefresh,
} from "./kit";
import { COLORS, TOUCH_TARGET } from "./theme";

/**
 * Runs `fn` with `Platform.OS` forced to `"android"`, then restores whatever
 * it was.
 *
 * WHY THIS IS THE ONLY WAY TO SEE `android_ripple` FROM A TEST. `Pressable`
 * destructures the prop OUT and never forwards it — `useAndroidRippleForView`
 * (react-native's own hook backing it) only turns it into `nativeBackgroundAndroid`
 * / `nativeForegroundAndroid` on the host view it renders when
 * `Platform.OS === "android"`; on any other platform the prop is simply
 * dropped, by design. jest's default platform here is iOS (there is no
 * `.android.js` variant of this app's own files, so nothing else in this suite
 * depends on the value), so a ripple assertion has to force the branch the
 * prop only takes on the platform it is FOR.
 */
function withAndroid<T>(fn: () => T): T {
  const original = Platform.OS;
  // @ts-expect-error `OS` is typed read-only; RN's jest mock backs it with a
  // plain, reassignable property, and nothing here touches a real native module.
  Platform.OS = "android";
  try {
    return fn();
  } finally {
    // @ts-expect-error see above
    Platform.OS = original;
  }
}

/**
 * The nearest HOST `View` above a node.
 *
 * `getByText` hands back the composite `Text`, whose `.parent` is another
 * composite — `toHaveStyle` needs a host element, and identity comparisons
 * between two composites say nothing about the tree. Walking to the first host
 * View is how a test reaches the column both Texts sit in without a testID
 * (the mobile convention: production stays a11y-only).
 */
function columnOf(node: { parent: unknown }): { type: string; props: Record<string, unknown> } {
  let current = node.parent as { type?: unknown; parent: unknown } | null;
  while (current !== null && current.type !== "View") {
    current = current.parent as { type?: unknown; parent: unknown } | null;
  }
  if (current === null) throw new Error("no host View above this node");
  return current as unknown as { type: string; props: Record<string, unknown> };
}

const LABEL = "Terminar una medicación";
// The RecordEventScreen caption verbatim (RecordEventScreen.tsx): 90 chars,
// wider than any phone at 12px — the case that overflowed on 2026-09-03.
const CAPTION =
  'Se hace desde el asiento del inicio del tratamiento, en la libreta: "Terminar medicación".';

describe("ListRow — the live row", () => {
  it("renders the label and fires onPress, announcing enabled", () => {
    const onPress = jest.fn();
    render(<ListRow label="Credencial pública" onPress={onPress} />);
    fireEvent.press(screen.getByText("Credencial pública"));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button").props.accessibilityState.disabled).toBe(false);
    expect(screen.queryByText(CAPTION)).toBeNull(); // no caption → no caption node
  });
});

describe("ListRow — the inert row says why", () => {
  it("renders the label AND the caption", () => {
    render(<ListRow label={LABEL} caption={CAPTION} />);
    expect(screen.getByText(LABEL)).toBeOnTheScreen();
    expect(screen.getByText(CAPTION)).toBeOnTheScreen();
  });

  it("announces disabled when there is no onPress", () => {
    render(<ListRow label={LABEL} caption={CAPTION} />);
    expect(screen.getByRole("button").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByRole("button").props.disabled ?? true).toBe(true);
  });

  it("bounds the caption so a long sentence wraps inside the row instead of running past it", () => {
    // Three halves of one bound, and each is satisfiable by a change that
    // breaks another: the COLUMN gives way (without it the text overflows the
    // row), the caption caps its height (without it a list of rows becomes a
    // page of paragraphs), and it carries a lineHeight (without it the two
    // wrapped lines sit on each other).
    render(<ListRow label={LABEL} caption={CAPTION} />);
    const caption = screen.getByText(CAPTION);
    expect(StyleSheet.flatten(columnOf(caption).props.style)).toMatchObject({ flexShrink: 1 });
    expect(typeof caption.props.numberOfLines).toBe("number");
    expect(caption.props.numberOfLines).toBeGreaterThanOrEqual(2);
    const style = StyleSheet.flatten(caption.props.style) as { lineHeight?: number };
    expect(typeof style.lineHeight).toBe("number");
  });

  it("does NOT let the label shrink — the primary text is the last thing that breaks", () => {
    // Yoga distributes negative space in proportion to each child's basis, so
    // a shrinkable label gives up ~66 points and wraps. `components.tsx`'s
    // row/rowLabel/rowValue already made this call: the value shrinks, the
    // label does not. Asserted on BOTH arms because they are separate styles.
    render(<ListRow label={LABEL} caption={CAPTION} />);
    expect(screen.getByText(LABEL)).not.toHaveStyle({ flexShrink: 1 });
    screen.unmount();
    render(<ListRow label={LABEL} caption={CAPTION} onPress={() => {}} />);
    expect(screen.getByText(LABEL)).not.toHaveStyle({ flexShrink: 1 });
  });

  it("stacks the caption UNDER the label rather than beside it", () => {
    // Side by side the caption gets ~108 points — about 17 characters a line,
    // so two lines show ~34 of these 90 and the sentence that says where the
    // real control lives is lost. That is the failure the row was introduced
    // to fix, so the two share one column and the column is a column.
    render(<ListRow label={LABEL} caption={CAPTION} />);
    const column = columnOf(screen.getByText(CAPTION));
    expect(column).toBe(columnOf(screen.getByText(LABEL)));
    // No `flexDirection: "row"` on it: RN's default is column, and the row
    // direction lives one level up, on the Pressable.
    const style = StyleSheet.flatten(column.props.style) as { flexDirection?: string };
    expect(style.flexDirection).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M10 — native-feel audit (2026-09-24): keyboard dismiss on selection, and
// android_ripple next to pressedOpacity, both in the SHARED primitives so
// every screen gets them without copying the same lines in per screen (the
// two BreedPickers already did the keyboard half locally, M6 — see
// AltaScreen.test.tsx's "el picker de raza cierra el teclado").
// ---------------------------------------------------------------------------

describe("ListRow — closes the keyboard on press (M10)", () => {
  it("dismisses the keyboard when a live row is pressed", () => {
    const dismiss = jest.spyOn(Keyboard, "dismiss");
    render(<ListRow label="Credencial pública" onPress={() => {}} />);
    fireEvent.press(screen.getByText("Credencial pública"));
    expect(dismiss).toHaveBeenCalled();
    dismiss.mockRestore();
  });

  it("never throws on the inert row — there is no onPress to wrap", () => {
    const dismiss = jest.spyOn(Keyboard, "dismiss");
    render(<ListRow label={LABEL} caption={CAPTION} />);
    // The inert row's Pressable renders with no onPress at all; firing press on
    // a disabled Pressable is a no-op in RNTL, and this only pins that the
    // wrapping did not turn "no handler" into "a handler that dismisses".
    fireEvent.press(screen.getByText(LABEL));
    expect(dismiss).not.toHaveBeenCalled();
    dismiss.mockRestore();
  });

  it("still calls the caller's onPress — dismissing must not swallow the action", () => {
    const onPress = jest.fn();
    render(<ListRow label="Credencial pública" onPress={onPress} />);
    fireEvent.press(screen.getByText("Credencial pública"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("clips its ripple to the row's own bounds, in the same tint the kit uses for 'active'", () => {
    withAndroid(() => {
      render(<ListRow label="Credencial pública" onPress={() => {}} />);
      expect(screen.getByRole("button").props.nativeBackgroundAndroid).toMatchObject({
        color: processColor(RIPPLE.color),
        borderless: false,
      });
    });
  });
});

describe("Choice — closes the keyboard on selection (M10)", () => {
  const OPTIONS = ["si", "no"] as const;

  it("dismisses the keyboard AND selects, in that order surviving even if onSelect throws nothing", () => {
    const dismiss = jest.spyOn(Keyboard, "dismiss");
    const onSelect = jest.fn();
    render(
      <Choice
        label="¿Falleció en una veterinaria?"
        options={OPTIONS}
        selected={null}
        optionLabel={(v) => (v === "si" ? "Sí" : "No")}
        onSelect={onSelect}
      />,
    );
    fireEvent.press(screen.getByText("Sí"));
    expect(dismiss).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("si");
    dismiss.mockRestore();
  });

  it("gives every chip a bounded ripple, not the icon-button borderless one", () => {
    withAndroid(() => {
      render(
        <Choice
          label="¿Falleció en una veterinaria?"
          options={OPTIONS}
          selected={null}
          optionLabel={(v) => (v === "si" ? "Sí" : "No")}
          onSelect={() => {}}
        />,
      );
      const chips = screen.getAllByRole("radio");
      expect(chips).toHaveLength(OPTIONS.length);
      for (const chip of chips) {
        expect(chip.props.nativeBackgroundAndroid).toMatchObject({
          color: processColor(RIPPLE.color),
          borderless: false,
        });
      }
    });
  });
});

describe("android_ripple — bounded, borderless and on-fill land on the right controls (M10)", () => {
  it("PrimaryButton gets the translucent-white ripple, for a saturated fill", () => {
    withAndroid(() => {
      render(<PrimaryButton label="Guardar" onPress={() => {}} />);
      expect(screen.getByRole("button").props.nativeBackgroundAndroid).toMatchObject({
        color: processColor(RIPPLE_ON_FILL.color),
        borderless: false,
      });
    });
  });

  it("SecondaryButton gets the bounded kit ripple, like a row — its fill is the light surface", () => {
    withAndroid(() => {
      render(<SecondaryButton label="Cancelar" onPress={() => {}} />);
      expect(screen.getByRole("button").props.nativeBackgroundAndroid).toMatchObject({
        color: processColor(RIPPLE.color),
        borderless: false,
      });
    });
  });

  it("LinkText and the password-reveal toggle get the BORDERLESS ripple — neither has its own background", () => {
    withAndroid(() => {
      render(<LinkText onPress={() => {}}>¿Olvidaste tu contraseña?</LinkText>);
      expect(screen.getByRole("link").props.nativeBackgroundAndroid).toMatchObject({
        color: processColor(RIPPLE_BORDERLESS.color),
        borderless: true,
      });
      screen.unmount();

      render(<PasswordField label="Contraseña" value="" onChangeText={() => {}} />);
      expect(
        screen.getByLabelText("Mostrar contraseña").props.nativeBackgroundAndroid,
      ).toMatchObject({
        color: processColor(RIPPLE_BORDERLESS.color),
        borderless: true,
      });
    });
  });

  it("keeps the two shapes visually distinct — one clips, the other does not", () => {
    expect(RIPPLE.borderless).not.toBe(true);
    expect(RIPPLE_BORDERLESS.borderless).toBe(true);
    // Same tint on both — only the SHAPE differs, not which "state" it means.
    expect(RIPPLE_BORDERLESS.color).toBe(RIPPLE.color);
  });
});

describe("Screen — dismisses the keyboard on a drag, not just on a tap (M10)", () => {
  it("sets keyboardDismissMode on-drag alongside the existing keyboardShouldPersistTaps", () => {
    render(
      <Screen>
        <Text>contenido</Text>
      </Screen>,
    );
    const scrollView = screen.UNSAFE_getByType(ScrollView);
    expect(scrollView.props.keyboardDismissMode).toBe("on-drag");
    // NOT relaxed by this change — a tap on a button inside the scroll view
    // must still fire the button and not only close the keyboard.
    expect(scrollView.props.keyboardShouldPersistTaps).toBe("handled");
  });
});

describe("FieldLabel — the asterisk is decoration, and stays out of the a11y tree", () => {
  it("renders the asterisk as a SIBLING node hidden from assistive tech, not nested text", () => {
    // CA-M3 (2026-09-05 audit): a nested <Text> is flattened into its parent's
    // native node on Android, so hiding flags on the inner span were lost and
    // TalkBack read "Nombre asterisco". Two Texts in a row are two nodes.
    render(<FieldLabel required>Nombre</FieldLabel>);
    const label = screen.getByText("Nombre");
    expect(label.props.children).toBe("Nombre"); // the label text alone, no nested span
    // Hidden from the a11y tree means hidden from the default query too — the
    // opt-in is the assertion: an asterisk `getByText` finds WITHOUT it is one a
    // screen reader would also find.
    expect(screen.queryByText("*")).toBeNull();
    const asterisk = screen.getByText("*", { includeHiddenElements: true });
    expect(asterisk.props.accessibilityElementsHidden).toBe(true);
    expect(asterisk.props.importantForAccessibility).toBe("no");
    expect(columnOf(asterisk)).toBe(columnOf(label)); // siblings under one host View
  });

  it("renders no asterisk at all on an optional field", () => {
    render(<FieldLabel>Marca</FieldLabel>);
    expect(screen.queryByText("*", { includeHiddenElements: true })).toBeNull();
  });

  it("lets a long label WRAP rather than push the asterisk out of the row", () => {
    // The sibling asterisk turned this label into a flex ROW, and yoga defaults
    // every child to `flexShrink: 0` — so a label wider than the row measured at
    // its full intrinsic width and laid the asterisk out past the parent's right
    // edge. This is `DenunciaScreen`'s longest one, verbatim: 33 characters
    // rendered uppercase in mono with letterspacing, which overflows on its own
    // at the Android font scales this app is expected to survive (≥ 1.3,
    // measured on a device).
    //
    // ASSERTED ON THE STYLE AND NOT ON A MEASURED WIDTH because jsdom lays
    // nothing out: there is no width here to overflow. What is checkable is the
    // intent — which of the two children yields — and it is the whole fix.
    const LONG = "¿Qué o a quién estás denunciando?";
    render(<FieldLabel required>{LONG}</FieldLabel>);
    expect(screen.getByText(LONG)).toHaveStyle({ flexShrink: 1 });
    // And the mark itself does NOT yield: an asterisk squeezed to zero width is
    // the same defect wearing a different name.
    expect(screen.getByText("*", { includeHiddenElements: true })).toHaveStyle({ flexShrink: 0 });
  });
});

describe("TextField — the return key belongs to the field, not to the crash fix", () => {
  // THE REGRESSION THIS PINS WAS SHIPPED AND CAUGHT IN REVIEW, not imagined.
  // The Android <=9 crash fix set `submitBehavior="submit"` on every TextInput
  // the kit renders. React Native's own typing says what that costs a MULTILINE
  // field: `undefined` defaults to `"newline"`, while `"submit"` "will only
  // send a submit event and not blur" — so Enter stopped inserting a line
  // break in all 26 multiline fields, and a denuncia became one run-on
  // paragraph.
  //
  // It bought nothing: the crash is reached only through `shouldBlurOnReturn()`,
  // which is already false for multiline. The fix was never needed there.

  it("leaves a MULTILINE field's submitBehavior alone, so Enter still types a newline", () => {
    render(<TextField label="Qué pasó" multiline value="" onChangeText={() => {}} />);
    // `undefined`, not `"submit"` — RN then applies its own multiline default.
    expect(screen.getByLabelText("Qué pasó").props.submitBehavior).toBeUndefined();
  });

  it("still floors a SINGLE-LINE field at 'submit', which is the crash fix", () => {
    // The other half. Asserting only the multiline arm would pass on a revert
    // that dropped the default entirely and brought the crash back.
    render(<TextField label="Nombre" value="" onChangeText={() => {}} />);
    expect(screen.getByLabelText("Nombre").props.submitBehavior).toBe("submit");
  });

  it("lets a caller override either way — a floor, not a lock", () => {
    render(
      <TextField
        label="Notas"
        multiline
        submitBehavior="submit"
        value=""
        onChangeText={() => {}}
      />,
    );
    expect(screen.getByLabelText("Notas").props.submitBehavior).toBe("submit");
  });
});

describe("TextField — the accessible name", () => {
  it("keeps the ', obligatorio' suffix when a caller passes its own accessibilityLabel", () => {
    // CA-M1/CA-M2 (2026-09-05 audit): `...rest` used to be spread AFTER the
    // derived name, so an explicit label wiped the suffix and a screen reader
    // heard no requiredness on the alta's name field or the locality picker.
    render(
      <TextField
        label="Nombre"
        required
        accessibilityLabel="Nombre de la mascota"
        value=""
        onChangeText={() => {}}
      />,
    );
    expect(screen.getByLabelText("Nombre de la mascota, obligatorio")).toBeOnTheScreen();
  });

  it("derives the name from the visible label when nothing is passed", () => {
    render(<TextField label="Lote" value="" onChangeText={() => {}} />);
    expect(screen.getByLabelText("Lote")).toBeOnTheScreen();
  });
});

describe("DateField / TimeField — a number pad and a mask", () => {
  it("opens a numeric keyboard on BOTH platforms — inputMode, never an iOS-only keyboardType", () => {
    // forms-F1: `keyboardType="numbers-and-punctuation"` exists on iOS only;
    // Android fell back to QWERTY on every date field in the app.
    render(<DateField label="Fecha" required value="" onChangeText={() => {}} />);
    const input = screen.getByLabelText("Fecha, obligatorio");
    expect(input.props.inputMode).toBe("numeric");
    expect(input.props.keyboardType).toBeUndefined();
    expect(input.props.placeholder).toBe("DD/MM/AAAA");
  });

  it("hands the caller the MASKED value, so the field and its state agree", () => {
    const onChangeText = jest.fn();
    render(<DateField label="Fecha" value="" onChangeText={onChangeText} />);
    fireEvent.changeText(screen.getByLabelText("Fecha"), "20082026");
    expect(onChangeText).toHaveBeenCalledWith("20/08/2026");
  });

  it("masks a time with a colon", () => {
    const onChangeText = jest.fn();
    render(<TimeField label="Hora" value="" onChangeText={onChangeText} />);
    const input = screen.getByLabelText("Hora");
    expect(input.props.inputMode).toBe("numeric");
    fireEvent.changeText(input, "0800");
    expect(onChangeText).toHaveBeenCalledWith("08:00");
  });
});

describe("DateField / TimeField — the native Android picker in front of the mask (M18)", () => {
  // `DateTimePickerAndroid` is the spy from jest.setup.js. The test plays the
  // dialog: it reads the params the field handed to `open` and calls their
  // `onValueChange` (a selection) or `onDismiss` (a cancel).
  type OpenParams = {
    mode: "date" | "time";
    value: Date;
    is24Hour?: boolean;
    minimumDate?: Date;
    maximumDate?: Date;
    onValueChange?: (event: unknown, date?: Date) => void;
    onDismiss?: () => void;
  };
  const open = DateTimePickerAndroid.open as unknown as jest.Mock<(params: OpenParams) => void>;
  const lastOpen = (): OpenParams => {
    const call = open.mock.calls.at(-1);
    if (call === undefined) throw new Error("the picker was never opened");
    return call[0];
  };

  /**
   * The field in picker mode. It starts as the typed mask until the screen-
   * reader query answers, so every picker test waits for that answer first.
   */
  async function pickerField(label: string) {
    await waitFor(() =>
      expect(screen.getByLabelText(label).props.showSoftInputOnFocus).toBe(false),
    );
    return screen.getByLabelText(label);
  }

  beforeEach(() => {
    open.mockClear();
    jest.replaceProperty(Platform, "OS", "android");
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("opens the native calendar on a completed tap, with the keyboard suppressed", async () => {
    render(<DateField label="Fecha" value="20/08/2026" onChangeText={() => {}} />);
    const input = await pickerField("Fecha");
    fireEvent.press(input);
    expect(open).toHaveBeenCalledTimes(1);
    const params = lastOpen();
    expect(params.mode).toBe("date");
    // The field's own value is where the calendar opens.
    expect([params.value.getDate(), params.value.getMonth(), params.value.getFullYear()]).toEqual([
      20, 7, 2026,
    ]);
  });

  it("does NOT open on the first touch of a gesture — a scroll starting on the field", async () => {
    render(<DateField label="Fecha" value="" onChangeText={() => {}} />);
    fireEvent(await pickerField("Fecha"), "pressIn");
    expect(open).not.toHaveBeenCalled();
  });

  it("closes the keyboard when focus arrives without a tap, and opens nothing", async () => {
    // The return-key chain focuses the next field with the keyboard still up.
    const dismiss = jest.spyOn(Keyboard, "dismiss");
    const onFocus = jest.fn();
    render(<DateField label="Fecha" value="" onChangeText={() => {}} onFocus={onFocus} />);
    fireEvent(await pickerField("Fecha"), "focus");
    expect(dismiss).toHaveBeenCalled();
    expect(onFocus).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("writes a selection as the SAME masked string the typed field produces", async () => {
    const onChangeText = jest.fn();
    render(<DateField label="Fecha" value="" onChangeText={onChangeText} />);
    fireEvent.press(await pickerField("Fecha"));
    act(() => {
      lastOpen().onValueChange?.({ type: "set" }, new Date(2026, 7, 5, 12));
    });
    // Typing 05082026 yields exactly this — one string, whichever door it used.
    expect(onChangeText).toHaveBeenCalledWith("05/08/2026");
  });

  it("leaves the value alone when the dialog is cancelled", async () => {
    const onChangeText = jest.fn();
    render(<DateField label="Fecha" value="20/08/2026" onChangeText={onChangeText} />);
    fireEvent.press(await pickerField("Fecha"));
    act(() => {
      lastOpen().onDismiss?.();
    });
    expect(onChangeText).not.toHaveBeenCalled();
  });

  it("passes the caller's bounds to the calendar, and clamps where it opens", async () => {
    const min = new Date(2026, 8, 1, 12);
    const max = new Date(2026, 8, 24, 12);
    render(
      <DateField
        label="Fecha"
        value="30/12/2026"
        minimumDate={min}
        maximumDate={max}
        onChangeText={() => {}}
      />,
    );
    fireEvent.press(await pickerField("Fecha"));
    const params = lastOpen();
    expect(params.minimumDate).toBe(min);
    expect(params.maximumDate).toBe(max);
    expect(params.value.getTime()).toBe(max.getTime());
  });

  it("opens a 24-hour clock for a time and writes HH:MM", async () => {
    const onChangeText = jest.fn();
    render(<TimeField label="Hora" value="" onChangeText={onChangeText} />);
    fireEvent.press(await pickerField("Hora"));
    const params = lastOpen();
    expect(params.mode).toBe("time");
    expect(params.is24Hour).toBe(true);
    act(() => {
      params.onValueChange?.({ type: "set" }, new Date(2026, 7, 20, 8, 5));
    });
    expect(onChangeText).toHaveBeenCalledWith("08:05");
  });

  it("does not open on a field the caller disabled", async () => {
    render(<DateField label="Fecha" value="" editable={false} onChangeText={() => {}} />);
    fireEvent.press(await pickerField("Fecha"));
    expect(open).not.toHaveBeenCalled();
  });

  it("offers the typed mask as a fallback, one tap away", async () => {
    const onChangeText = jest.fn();
    render(<DateField label="Fecha" value="" onChangeText={onChangeText} />);
    await pickerField("Fecha");
    fireEvent.press(screen.getByRole("button", { name: "Escribir la fecha" }));
    const input = screen.getByLabelText("Fecha");
    expect(input.props.showSoftInputOnFocus).toBeUndefined();
    fireEvent.press(input);
    expect(open).not.toHaveBeenCalled();
    fireEvent.changeText(input, "20082026");
    expect(onChangeText).toHaveBeenCalledWith("20/08/2026");
    // And back again.
    fireEvent.press(screen.getByRole("button", { name: "Elegir en el calendario" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("gives the fallback link a full touch target that stops where the input starts", async () => {
    render(<DateField label="Fecha" value="" onChangeText={() => {}} />);
    await pickerField("Fecha");
    const link = screen.getByRole("button", { name: "Escribir la fecha" });
    const slop = link.props.hitSlop as { top: number; bottom: number };
    const text = screen.getByText("Escribir la fecha");
    const lineHeight = StyleSheet.flatten(text.props.style).lineHeight as number;
    expect(slop.top + slop.bottom + lineHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    // The top slop fits inside the gap above the link, so it never overlaps the input.
    const marginTop = StyleSheet.flatten(link.props.style).marginTop as number;
    expect(marginTop).toBeGreaterThanOrEqual(slop.top);
  });

  it("with TalkBack on, the field is the typed mask only", async () => {
    jest.spyOn(AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
    render(<DateField label="Fecha" value="" onChangeText={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Escribir la fecha" })).toBeNull();
    const input = screen.getByLabelText("Fecha");
    expect(input.props.showSoftInputOnFocus).toBeUndefined();
    fireEvent.press(input);
    expect(open).not.toHaveBeenCalled();
  });

  it("stays the typed mask until the screen-reader answer arrives", () => {
    // Never answers: the field must not guess "no screen reader".
    jest
      .spyOn(AccessibilityInfo, "isScreenReaderEnabled")
      .mockReturnValue(new Promise<boolean>(() => {}));
    render(<DateField label="Fecha" value="" onChangeText={() => {}} />);
    expect(screen.getByLabelText("Fecha").props.showSoftInputOnFocus).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Escribir la fecha" })).toBeNull();
  });

  it("stays the typed mask off Android", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    render(<DateField label="Fecha" value="" onChangeText={() => {}} />);
    fireEvent.press(screen.getByLabelText("Fecha"));
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Escribir la fecha" })).toBeNull();
  });
});

describe("pullToRefresh — the kit's RefreshControl, already coloured", () => {
  it("returns a RefreshControl carrying the callback, the flag and the accent", () => {
    const onRefresh = jest.fn();
    const control = pullToRefresh(onRefresh, true);
    expect(control.type).toBe(RefreshControl);
    // Exact, not a subset: a future prop added to the factory should be a
    // decision somebody makes here rather than one that arrives unnoticed.
    expect(control.props).toEqual({
      colors: [COLORS.accent],
      onRefresh,
      refreshing: true,
      tintColor: COLORS.accent,
    });
  });

  it("reaches the Screen's scroll view, and one pull calls back exactly once", () => {
    const onRefresh = jest.fn();
    render(
      <Screen refreshControl={pullToRefresh(onRefresh, false)}>
        <Text>cuerpo</Text>
      </Screen>,
    );
    // UNSAFE_ by the no-testID convention (skeleton.test.tsx states it): the
    // control has no accessible name of its own, so the type is the handle.
    const control = screen.UNSAFE_getByType(RefreshControl);
    expect(control.props.refreshing).toBe(false);
    fireEvent(control, "refresh");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("PasswordField — the eye toggle may not cap the input (B-08)", () => {
  it("stretches its row instead of centring it", () => {
    // MEASURED on build 10 at font scale 1.5 (shot 157): the e-mail field grew
    // to 54.9dp and the password field beside it stayed at 44.6dp. The cause is
    // in one word of one style: `alignItems: "center"` sizes each child by its
    // own content, so the row took the eye toggle's `minHeight: TOUCH_TARGET`
    // as its answer — a 44pt TAP TARGET was capping the height of the text
    // somebody was typing. `stretch` makes the row as tall as the input and
    // grows the toggle to match.
    //
    // ASSERTED ON THE STYLE AND NOT ON A MEASURED HEIGHT, for kit.test.tsx's
    // standing reason: jsdom lays nothing out, so there is no height here to be
    // wrong. The style IS the mechanism.
    render(<PasswordField label="Contraseña" value="" onChangeText={() => {}} />);
    const row = columnOf(screen.getByLabelText("Contraseña"));
    const style = StyleSheet.flatten(row.props.style as never) as { alignItems?: string };
    // ONE assertion, because `not.toBe("center")` after `toBe("stretch")` cannot
    // fail without the line above failing first — a vacuous line that reads like
    // a second check (nit N2, review 2026-09-07). The value IS the mechanism, so
    // pinning the value is the whole test.
    expect(style.alignItems).toBe("stretch");
  });
});

// ---------------------------------------------------------------------------
// The keyboard the long forms type under (open-work row 11, fixed 2026-09-11)
//
// `Screen`'s `keyboardAvoiding` prop passed `behavior={Platform.OS === "ios" ?
// "padding" : undefined}`, and `undefined` is not "a sensible default" — React
// Native's `KeyboardAvoidingView` switches on `behavior` and its `default:` arm
// returns a plain `<View>`. Sixteen screens asked for keyboard avoidance on
// Android and sixteen got nothing, which survived only while Android's own
// window resize compensated for it. Expo SDK 54+ enforces edge-to-edge, the
// window stopped resizing, and the compensation left.
//
// THE RULE IS TESTED AS A FUNCTION BECAUSE JEST RUNS ON ONE PLATFORM. A render
// assertion can only ever see the arm this runner takes; the defect was on the
// other one.
// ---------------------------------------------------------------------------

describe("keyboardAvoidingBehavior — accused and acquitted on 2026-09-11", () => {
  // NOT ONE ASSERTION IN THIS BLOCK CHANGED, and saying so is the point.
  //
  // On 2026-09-11 `keyboardAvoidingBehavior` was accused of the crash reported
  // from a real device as Android's own "dejó de funcionar", on the theory that
  // `"height"` — which had shipped in build 11 — was closing the app on every
  // screen whose keyboard opened. The function was reverted for an afternoon
  // and these assertions were rewritten to match.
  //
  // THE THEORY WAS WRONG. The stack, once it arrived over adb, named a
  // ClassCastException in React Native's own `ReactEditText`, reached through
  // `onEditorAction` and nothing to do with `KeyboardAvoidingView`. The
  // accusation rested on "only one variable changed between builds 10 and 11",
  // which was itself false — 163 mobile files had. So the revert was undone and
  // the assertions came back exactly as they were; only this note and the
  // titles are new.
  //
  // An earlier draft of this comment claimed the block "used to assert the
  // opposite" and had been "inverted". It had not. That sentence survived the
  // un-revert and was caught in review — a false record in a test file is worse
  // than no record, because the next reader believes it.
  //
  // THE RULE IS STILL TESTED AS A FUNCTION, for the original reason: Jest runs
  // on one platform, and a render assertion can only ever see the arm this
  // runner takes. The defect was always on the other one.

  it("asks Android to shrink", () => {
    // Restored after the crash's real stack arrived: a ClassCastException in
    // React Native's ReactEditText, reached through onEditorAction. This
    // function was reverted for an afternoon on evidence that did not hold.
    expect(keyboardAvoidingBehavior("android")).toBe("height");
  });

  it("still asks iOS to pad", () => {
    // Unchanged and unaffected: the crash was Android-only, and iOS never had
    // the no-op in the first place.
    expect(keyboardAvoidingBehavior("ios")).toBe("padding");
  });

  it("gives the two platforms DIFFERENT answers", () => {
    // Survives a collapse to a constant in either direction.
    expect(keyboardAvoidingBehavior("android")).not.toBe(keyboardAvoidingBehavior("ios"));
  });

  it("returns only values React Native's `behavior` prop accepts", () => {
    // The property that outlives whichever way the Android arm is pointing:
    // every answer must be something `KeyboardAvoidingView` actually switches
    // on. `undefined` does NOT qualify — it renders a plain <View>, which is
    // the silent no-op this function exists to prevent, and the assertion below
    // rejects it. (A previous version of this comment said the opposite, left
    // over from the afternoon the Android arm was reverted; it was contradicted
    // by the very line under it.)
    for (const os of ["ios", "android", "windows", "macos", "web"] as const) {
      expect(["padding", "height"]).toContain(keyboardAvoidingBehavior(os));
    }
  });
});

describe("Screen keyboardAvoiding — the prop reaches a real KeyboardAvoidingView", () => {
  it("mounts one, with a behavior that is not undefined", () => {
    render(
      <Screen keyboardAvoiding>
        <TextField label="Nombre" value="" onChangeText={() => {}} />
      </Screen>,
    );
    const avoider = screen.UNSAFE_getByType(KeyboardAvoidingView);
    // NOT compared against `keyboardAvoidingBehavior(Platform.OS)` — that would
    // derive the expectation from the code under test and pass for any value,
    // `undefined` included. The membership check is the real contract.
    expect(["padding", "height"]).toContain(avoider.props.behavior);
  });

  it("mounts NO avoider when the screen did not ask for one", () => {
    // The control. Without it the test above would still pass on a `Screen` that
    // wrapped every child in a KeyboardAvoidingView unconditionally, which is a
    // different component from the one this kit documents.
    render(
      <Screen>
        <Text>cuerpo</Text>
      </Screen>,
    );
    expect(screen.UNSAFE_queryAllByType(KeyboardAvoidingView)).toHaveLength(0);
  });
});
