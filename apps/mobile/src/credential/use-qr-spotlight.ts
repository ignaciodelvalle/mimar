// The QR moment: screen awake, brightness up — both undone on the way out.
//
// QOL 2026-09-01. The credential is the screen an owner HOLDS UP: to a vet at
// a counter, to a stranger who found the animal. Two things ruin that moment
// on a real phone: the screen dimming and locking mid-scan (a 30-second
// timeout is shorter than a nervous conversation), and a low-brightness
// screen a camera cannot read in the street. The web cannot fix either; the
// app can, and only while it matters.
//
// WINDOW brightness, not system brightness — `expo-brightness`'s
// `setBrightnessAsync` raises the CURRENT ACTIVITY's window on Android and the
// screen on iOS, and needs no permission for either.
//
// RAISING IS THE EASY HALF. Releasing is where this hook was wrong twice, and
// both errors were found by measurement rather than by reading: the platform
// half is in `releaseSpotlight`, the lifetime half in the two effects below.
//
// BEST-EFFORT, ALL OF IT. An emulator with no brightness service, or a build
// where the native module is not yet linked (this dep lands with the D2 EAS
// build), must degrade to "the screen behaves as always" — never to a crash on
// the single most public screen in the app. Every platform call in this file is
// inside a `try`, and a failed capture means nothing is raised and nothing is
// restored.

import * as Brightness from "expo-brightness";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useId, useState } from "react";
import { AppState, Platform } from "react-native";

/**
 * A DEDICATED TAG, not the default one `activateKeepAwakeAsync()` falls back
 * to when called with no argument. expo-keep-awake tracks activations PER
 * TAG — a `deactivateKeepAwake()` releases only the lock its own tag holds —
 * so sharing the default tag with some other future caller in this app would
 * let either one release the other's lock by accident. This screen's lock is
 * its own.
 *
 * PER-INSTANCE, not a module-level constant (fresh-context review,
 * pre-push): a hardcoded string tag is shared by EVERY mounted instance of
 * this hook, so two credential screens open at once (a native-stack push on
 * top of another, or two tabs) would let either one's cleanup
 * `deactivateKeepAwake` release the OTHER instance's lock — the exact
 * per-tag isolation this comment already warns about, just one level up:
 * between two callers of the SAME hook, not two different hooks. `useId()`
 * scopes the tag to this render tree instance instead.
 */
const QR_SPOTLIGHT_KEEP_AWAKE_TAG_PREFIX = "qr-spotlight-";

/**
 * Hands brightness control back, by the one call per platform that actually
 * hands it back.
 *
 * ANDROID: `restoreSystemBrightnessAsync()`, NOT `setBrightnessAsync(previous)`,
 * and the difference is the whole reason this function exists. Android's
 * brightness is a WINDOW ATTRIBUTE with a sentinel: `lp.screenBrightness = -1`
 * (`BRIGHTNESS_OVERRIDE_NONE`) means "I am not overriding anything, let the
 * system decide". `setBrightnessAsync(v)` writes `lp.screenBrightness = v` —
 * so putting the captured level back does not stop the override, it merely
 * MOVES it, from a bright pin to a dim one. The app goes on dictating the
 * screen either way.
 *
 * The bug hid because `getBrightnessAsync()` falls back to reading the SYSTEM
 * level when no override is set, so the captured value always looked right and
 * the screen always looked right — on a phone in manual mode. On a phone in
 * automatic mode, which is the common one, the screen simply stopped adapting.
 *
 * MEASURED on a Samsung SM-J710MN (Android 8.1) with `adb shell dumpsys power`,
 * 2026-09-17. `mScreenBrightnessSetting` — the owner's own setting — stayed at
 * 148 the whole time; `mScreenBrightnessOverrideFromWindowManager` went:
 *
 *   255  credential open              correct: window-level, system untouched
 *   147  spotlight switched off       WRONG: should be -1, it pinned instead
 *   147  after leaving the screen     still pinned
 *    -1  after backgrounding the app  released, but only because Android did it
 *
 * So the leak was bounded to the session inside the app, not "until the app is
 * killed" as the debt board had it — and on the a11y escape hatch
 * (`qr-spotlight-preference.ts`) it was worse than a leak: someone with
 * photophobia who turned the spotlight off got a dim pin instead of their phone
 * back.
 *
 * iOS: `setBrightnessAsync(previous)`, unchanged, because there the current
 * behaviour is right. iOS has no window override to release — `setBrightnessAsync`
 * IS the screen brightness, and putting the captured value back is the only way
 * to undo it. `restoreSystemBrightnessAsync` would do nothing at all there:
 * expo-brightness returns early on any non-Android platform
 * (`build/Brightness.js`), so calling it unconditionally would simply leave
 * every iPhone at full brightness.
 */
async function releaseSpotlight(previous: number): Promise<void> {
  try {
    if (Platform.OS === "android") {
      await Brightness.restoreSystemBrightnessAsync();
      return;
    }
    await Brightness.setBrightnessAsync(previous);
  } catch {
    // Same contract as the raise: a missing native module must not crash the
    // credential. A screen that stays bright is a nuisance; a screen that
    // white-screens while somebody holds it up to a vet is the failure.
  }
}

/**
 * @param enabled Whether the owner wants the brightness raised. Defaults to
 * true, which is the behaviour this hook had before the preference existed.
 *
 * KEEP-AWAKE IS NOT PART OF THE CHOICE, deliberately. Turning the spotlight off
 * is about glare; a screen that locks mid-scan is a different failure and
 * bothers nobody. So the switch below governs the brightness half only.
 *
 * TOGGLING OFF WHILE MOUNTED RELEASES IMMEDIATELY — that is the whole point of
 * the control, so `enabled` feeds the same boolean that focus and app state do.
 */
export function useQrSpotlight(enabled = true): void {
  // Per-instance keep-awake tag (see QR_SPOTLIGHT_KEEP_AWAKE_TAG_PREFIX's
  // docblock): stable for the lifetime of this hook instance, distinct from
  // any other mounted instance's.
  const instanceId = useId();
  const keepAwakeTag = `${QR_SPOTLIGHT_KEEP_AWAKE_TAG_PREFIX}${instanceId}`;

  // FOCUS, NOT MOUNT — and this is the second half of the measured defect.
  // A native-stack screen stays MOUNTED underneath whatever is pushed on top of
  // it, so an unmount-only release meant the spotlight survived navigating
  // deeper into the app: open the credential, tap through to anything else, and
  // the pin outlived the screen that set it.
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  // KEEP-AWAKE, ON THE SAME FOCUS WINDOW AS THE BRIGHTNESS RAISE BELOW
  // (T4-M3, native QA batch 4). `useKeepAwake()` used to run for as long as
  // the component stayed MOUNTED — the asymmetry the comment above this one
  // used to warn about, and left deliberately unfixed at the time because
  // fixing it meant driving `activateKeepAwakeAsync`/`deactivateKeepAwake` by
  // hand instead of the mount-scoped hook. Now it is: `focused` already
  // captures "on screen and not buried under a pushed screen", so keep-awake
  // rides it instead of carrying its own, weaker rule. Deactivating on blur
  // means a reader who has navigated past the QR gets their battery back
  // immediately rather than only once they pop this screen off the stack.
  useEffect(() => {
    if (!focused) return;
    // .catch(() => {}) — same best-effort contract as every other platform
    // call in this file (see the module docblock): a rejected activation
    // (no native module linked, an emulator with no keep-awake service) must
    // degrade to "the screen behaves as always", never an unhandled
    // rejection on the single most public screen in the app.
    void activateKeepAwakeAsync(keepAwakeTag).catch(() => {});
    return () => {
      void deactivateKeepAwake(keepAwakeTag);
    };
  }, [focused, keepAwakeTag]);

  // BACKGROUNDING, which matters far more on iOS than on Android. On Android
  // the window override is cleared by the OS itself when the app leaves the
  // foreground (the `-1` in the measurement above), so this is belt-and-braces
  // there. On iOS there is no window: `setBrightnessAsync` moved the SYSTEM
  // brightness, and it persists until the device is locked — so an owner who
  // opens the credential and then switches to Maps has a phone at full
  // brightness until they lock it.
  //
  // `inactive` is NOT treated as gone, on purpose. iOS raises it for every
  // transient interruption — the Control Centre pull, the app switcher, an
  // incoming call — and releasing plus re-raising on each one would flicker the
  // screen of the person mid-conversation for no benefit. Only `background` is
  // a real departure, and only `active` is a real return.
  const [backgrounded, setBackgrounded] = useState(() => AppState.currentState === "background");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background") setBackgrounded(true);
      else if (next === "active") setBackgrounded(false);
    });
    return () => subscription.remove();
  }, []);

  // One boolean, three reasons to be false. Coming back from any of them
  // re-captures and re-raises, which is also the right thing: the owner may
  // have changed their brightness while they were away.
  const shouldRaise = enabled && focused && !backgrounded;

  useEffect(() => {
    if (!shouldRaise) return;
    let previous: number | null = null;
    let cancelled = false;
    void (async () => {
      try {
        // Kept on Android too, even though the value is discarded there — it is
        // the availability probe. A module that cannot answer this cannot
        // raise either, and a capture that never happened is what tells the
        // cleanup below there is nothing to put back.
        previous = await Brightness.getBrightnessAsync();
        // The cleanup can win the race against this read; setting AFTER a
        // cancelled capture would brighten a screen nobody is showing.
        if (cancelled) return;
        await Brightness.setBrightnessAsync(1);
        // And it can win the race against the SET, which is the nastier order:
        // the cleanup saw a captured `previous`, released, and then this landed
        // on top of the release and re-pinned the screen. This is the only
        // place that can observe that happened. The a11y control makes it
        // likelier than it sounds — someone who opens the credential because of
        // the glare taps the switch inside the same few hundred milliseconds.
        if (cancelled) void releaseSpotlight(previous);
      } catch {
        previous = null;
      }
    })();
    return () => {
      cancelled = true;
      if (previous !== null) void releaseSpotlight(previous);
    };
  }, [shouldRaise]);
}
