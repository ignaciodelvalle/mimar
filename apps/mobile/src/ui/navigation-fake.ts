// The navigation object a discard-guard test needs — one definition, not one
// per test file.
//
// TEST-ONLY, AND IMPORTED BY NO PRODUCTION MODULE. It lives under `src/`
// because that is jest's `roots`, and it is not a `.test.ts` because it holds
// no cases.
//
// WHY IT IS SHARED. The fake has two properties that are easy to get wrong and
// invisible when they are (finding H1, review 2026-09-07):
//
//   · A STABLE object. React Navigation hands back the same one; a fresh object
//     per render re-runs the guard's effect on every keystroke and stacks a
//     listener each time.
//   · A REAL unsubscribe. `addListener: () => () => {}` — the stub several
//     files carried — never fires the listener at all, so a screen that ships
//     WITHOUT a discard guard, or with one that intercepts its own success
//     navigation, passes every test in the file.
//
// TEN test files use it now — every jest file that mocks `expo-router` for a
// module which calls the guard — and `__tests__/mobile-a11y-fences.test.ts`
// holds that as a rule rather than as a habit (finding F4). N hand-written
// copies of a subtle fake is how one of them quietly degrades back into the
// stub, which is exactly what happened to `MudanzaScreen` and `DenunciaScreen`
// between this file being written and the review that counted them.

export type BeforeRemoveEvent = { preventDefault: () => void; data: { action: unknown } };

export type NavigationFake = {
  /** Pass this from a mocked `useNavigation`. Its identity never changes. */
  navigation: {
    addListener: (type: string, cb: (event: BeforeRemoveEvent) => void) => () => void;
    dispatch: (action: unknown) => void;
  };
  /** Fire the Android back gesture. `blocked` is what the guard decided. */
  pressBack: () => { blocked: boolean };
  /** Actions the guard dispatched after somebody confirmed the discard. */
  dispatched: unknown[];
  /** Between cases: a listener from a previous render must not answer here. */
  reset: () => void;
};

export function createNavigationFake(): NavigationFake {
  const listeners: ((event: BeforeRemoveEvent) => void)[] = [];
  const dispatched: unknown[] = [];

  return {
    navigation: {
      addListener: (_type, cb) => {
        listeners.push(cb);
        return () => {
          const at = listeners.indexOf(cb);
          if (at >= 0) listeners.splice(at, 1);
        };
      },
      dispatch: (action) => {
        dispatched.push(action);
      },
    },
    pressBack: () => {
      let blocked = false;
      const event: BeforeRemoveEvent = {
        preventDefault: () => {
          blocked = true;
        },
        data: { action: { type: "GO_BACK" } },
      };
      // A COPY, because a listener that unsubscribes while this runs would
      // otherwise shorten the array underneath the loop.
      for (const listener of [...listeners]) listener(event);
      return { blocked };
    },
    dispatched,
    reset: () => {
      listeners.length = 0;
      dispatched.length = 0;
    },
  };
}
