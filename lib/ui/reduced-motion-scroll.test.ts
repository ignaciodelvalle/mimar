// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scrollIntoViewRespectingMotion } from "./reduced-motion-scroll";

// jsdom implements no scrolling — stub the one method under test, matching the
// convention CredentialActionBar.test.tsx already uses for the same stub.
const scrollIntoView = vi.fn();

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}

describe("scrollIntoViewRespectingMotion", () => {
  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    // @ts-expect-error — restoring to "unimplemented", matching jsdom's default.
    window.matchMedia = undefined;
  });

  it("is a no-op when the target is null (the common not-found-yet case)", () => {
    scrollIntoViewRespectingMotion(null, { block: "center" });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls "smooth" when the user has no reduced-motion preference', () => {
    stubMatchMedia(false);
    const el = document.createElement("div");
    scrollIntoViewRespectingMotion(el, { block: "start" });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
  });

  it('downgrades to "auto" under prefers-reduced-motion', () => {
    stubMatchMedia(true);
    const el = document.createElement("div");
    scrollIntoViewRespectingMotion(el, { block: "center" });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
  });

  it('falls back to "smooth" when matchMedia is unavailable (e.g. an unpolyfilled test env)', () => {
    // @ts-expect-error — simulating jsdom's default (no matchMedia at all).
    window.matchMedia = undefined;
    const el = document.createElement("div");
    scrollIntoViewRespectingMotion(el, { block: "start" });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
  });
});
