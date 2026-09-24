// Scroll-to-error — the mobile mirror of the web's `useFormErrorFocus`.
//
// THE GAP IT CLOSES (QOL 2026-09-01): the long forms (asentar is ~700 lines
// of fields, the denuncia close behind) render their refusal Callout near the
// submit button, which is USUALLY on screen when the refusal appears — but
// not with the keyboard up, and not when a person scrolled back up to fix a
// field and re-submitted from memory. The web's spec line is "foco al primer
// error en submit fallido"; on a phone the screen-reader half already works
// (the err Callout is an assertive live region — kit.tsx), so what this hook
// adds is the SIGHTED half: put the message where the eyes are.
//
// TRANSITION-ONLY, exactly like the web hook: it moves the view when `error`
// goes from null to a message, and deliberately NOT when one message is
// replaced by another — re-scrolling on every failed retry of an already
// visible error is the "jarring focus jumps" the web hook's header warns
// about, in scroll form.
//
// TWO REFS COME BACK, AND THE SECOND ONE IS THE FIX (forms-F4, 2026-09-05
// audit — filed as "never scrolls", and worse than filed). The hook used to
// find the ScrollView through `ScreenScrollContext`, whose provider lives
// INSIDE `Screen`. Every consumer calls this hook from the component that
// RENDERS its Screen — above the provider — so `useContext` answered null on
// every screen, and the courtesy rule below turned that into a silent no-op.
// Two screens shipped with the hook wired and neither ever moved. The hook now
// owns a ref to the ScrollView and hands it back; the caller passes it to
// `<Screen scrollRef={…}>`, and the context remains as the fallback for a
// consumer that IS nested inside a Screen.
//
// EVERY NATIVE CALL IS BEST-EFFORT. A ref nobody attached, an unmounted
// anchor, or a measurement error must degrade to "no scroll" — the refusal
// itself is already visible to assistive tech and this hook is a courtesy,
// never a gate.

import { type RefObject, useContext, useEffect, useRef } from "react";
import type { ScrollView, View } from "react-native";

import { ScreenScrollContext } from "./kit";
import { SPACE } from "./theme";

/** Breathing room above the anchored message, so it lands readable, not flush. */
const SCROLL_MARGIN = SPACE.lg;

export type ScrollToError = {
  /** Put on the View that wraps the error Callout. */
  anchorRef: RefObject<View | null>;
  /** Pass to `<Screen scrollRef={…}>` — the door that actually reaches the scroll view. */
  scrollRef: RefObject<ScrollView | null>;
};

export function useScrollToError(error: string | null): ScrollToError {
  const contextRef = useContext(ScreenScrollContext);
  const scrollRef = useRef<ScrollView>(null);
  const anchorRef = useRef<View>(null);
  const prevRef = useRef<string | null>(null);

  useEffect(() => {
    const appeared = prevRef.current === null && error !== null;
    prevRef.current = error;
    if (!appeared) return;

    const scroll: ScrollView | null = scrollRef.current ?? contextRef?.current ?? null;
    const anchor = anchorRef.current;
    if (scroll === null || anchor === null) return;

    // Measure the anchor against the ScrollView's CONTENT (the inner view),
    // not the viewport — `scrollTo` speaks content coordinates.
    const host = scroll.getInnerViewNode();
    if (!host) return;
    anchor.measureLayout(
      host,
      (_x, y) => {
        scroll.scrollTo({ y: Math.max(0, y - SCROLL_MARGIN), animated: true });
      },
      () => {},
    );
  }, [error, contextRef]);

  return { anchorRef, scrollRef };
}
