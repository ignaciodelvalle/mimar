// Return-key advance — the keyboard's own "next field" button, wired.
//
// QOL 2026-09-01: the web moves between fields with Tab; on a phone the same
// affordance is the return key, and every form here made it a dead key — the
// keyboard closed, the person re-tapped the next field, six times on the
// profile form. `useReturnKeyChain(n)` gives each single-line field in a
// sequence the three props that fix it: a ref to focus through, "next"/"done"
// on the key itself, and a submit handler that moves focus WITHOUT closing
// the keyboard (`submitBehavior: "submit"`).
//
// CHAIN ONLY SINGLE-LINE FIELDS. A multiline field's return key types a
// newline — that is its job — and a picker's query field must not be focused
// uninvited (opening the breed search because somebody finished typing a name
// is the keyboard acting on a decision nobody made). Compose chains around
// them: the pet-edit screen runs one chain per save group.
//
// THE LAST FIELD SAYS "done" AND ONLY BLURS unless the caller passes
// `onDone`. Auto-submitting a whole edit form from a keyboard key is a
// decision each screen makes explicitly — the claim lookup does (typing the
// code and hitting the key IS the ask), the profile save does not (a person
// reviewing six fields has not said "save" yet).

import { type RefObject, createRef, useCallback, useRef } from "react";
import { Keyboard, type TextInput, type TextInputProps } from "react-native";

type ChainProps = {
  inputRef: RefObject<TextInput | null>;
  returnKeyType: NonNullable<TextInputProps["returnKeyType"]>;
  submitBehavior: NonNullable<TextInputProps["submitBehavior"]>;
  onSubmitEditing: () => void;
};

export function useReturnKeyChain(
  count: number,
  onDone?: () => void,
): (index: number) => ChainProps {
  const refs = useRef<Array<RefObject<TextInput | null>>>([]);
  while (refs.current.length < count) refs.current.push(createRef<TextInput>());

  return useCallback(
    (index: number) => {
      const last = index >= count - 1;
      const own = refs.current[index] ?? createRef<TextInput>();
      const next = refs.current[index + 1];
      return {
        inputRef: own,
        returnKeyType: last ? "done" : "next",
        // "submit" keeps the keyboard OPEN while focus moves; closing and
        // reopening it between every field is the flicker this hook removes.
        //
        // AND THE LAST FIELD USES IT TOO SINCE 2026-09-11, which is a crash fix
        // rather than a tidy-up. It used to ask for "blurAndSubmit" so the
        // keyboard would close on "done" — and that is the one value that sends
        // React Native into `clearFocusAndMaybeRefocus`, whose `rootView as
        // ViewGroup` cast throws on Android 9 and older. Measured over adb from
        // an Android 8.1 device: every form killed the app on its last field.
        // See the note in kit.tsx for the RN source and the version condition.
        //
        // The keyboard still closes, because we close it ourselves one line
        // below. Same behaviour for the person, without the broken path.
        submitBehavior: "submit",
        onSubmitEditing: () => {
          if (last) {
            // Explicitly, rather than by asking the native side to blur. This
            // is the half of "blurAndSubmit" we actually wanted.
            Keyboard.dismiss();
            onDone?.();
          } else next?.current?.focus();
        },
      };
    },
    [count, onDone],
  );
}
