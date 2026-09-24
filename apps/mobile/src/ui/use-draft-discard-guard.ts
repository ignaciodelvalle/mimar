// The discard guard, for a screen that does not receive a navigation object.
//
// WHY IT EXISTS (critic gap 2). `useDiscardGuard` has been in this tree since
// 2026-09-01 and had exactly ONE consumer: `app/alta.tsx`, which happens to sit
// in `app/` where `useNavigation()` is at hand. Every other writer screen —
// asentar, editar datos, denunciar, transferir, mudanza, cuidador, postularme,
// reservar un turno, crear cuenta, identidad — discards a filled-in form to the
// Android back gesture in silence, which is the defect the guard was written
// for. A guard with one consumer is a guard that was not adopted.
//
// WHY A SECOND HOOK RATHER THAN CHANGING THE FIRST. `useDiscardGuard` takes a
// structural navigation object and imports nothing — that is what makes it
// testable with a two-method fake and what keeps `src/pets/` free of
// expo-router. This wrapper is the one place that reaches for the router, so
// the rule stays: the POLICY is tested without a router, and this file is the
// three lines that bind it to one.
//
// A SCREEN TEST THAT MOCKS `expo-router` MUST PROVIDE `useNavigation`. There is
// no defensive fallback here on purpose: a guard that silently no-ops when the
// router is not what it expected is a guard whose absence nobody notices, which
// is precisely how this one spent a week with one consumer.

import { useNavigation } from "expo-router";

import { DISCARD_COPY, type DiscardCopy, useDiscardGuard } from "../pets/use-discard-guard";

/** React Navigation's object, narrowed to what the guard actually touches. */
type Guardable = {
  addListener: (
    type: "beforeRemove",
    cb: (e: { preventDefault: () => void; data: { action: unknown } }) => void,
  ) => () => void;
  dispatch: (action: unknown) => void;
};

/**
 * Confirm before leaving a form that has been typed in.
 *
 * Returns `allowLeave` — call it immediately before a programmatic exit the
 * guard must not intercept (the `router.replace` after a save that landed).
 */
export function useDraftDiscardGuard(dirty: boolean, copy: DiscardCopy = DISCARD_COPY.form) {
  const navigation = useNavigation() as unknown as Guardable;
  return useDiscardGuard(navigation, dirty, copy);
}
