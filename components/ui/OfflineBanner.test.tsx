// Smoke tests for <LnOfflineBanner>.
// Pattern: renderToStaticMarkup (see components/ui/EmptyState.test.tsx).
// useOnline() is mocked so the SSR render can control the offline/online
// state directly, without touching window/navigator (no jsdom needed here).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { useOnlineMock } = vi.hoisted(() => ({ useOnlineMock: vi.fn() }));
vi.mock("@/lib/hooks/useOnline", () => ({ useOnline: useOnlineMock }));

import { LnOfflineBanner } from "./OfflineBanner";

const OFFLINE_COPY =
  "Sin conexión — revisá tu internet. Los cambios no se van a guardar hasta que vuelva la conexión.";

describe("<LnOfflineBanner>", () => {
  it("renders nothing when online", () => {
    useOnlineMock.mockReturnValue(true);
    const html = renderToStaticMarkup(<LnOfflineBanner />);
    expect(html).toBe("");
  });

  it("renders the exact offline copy when offline", () => {
    useOnlineMock.mockReturnValue(false);
    const html = renderToStaticMarkup(<LnOfflineBanner />);
    expect(html).toContain(OFFLINE_COPY);
  });

  it('renders an <output> with aria-live="polite" (implicit status role — informational, not an alert)', () => {
    useOnlineMock.mockReturnValue(false);
    const html = renderToStaticMarkup(<LnOfflineBanner />);
    // <output>'s implicit ARIA role is "status" (same idiom as DemoModeBanner)
    // — no explicit role="status" attribute needed, and biome's
    // lint/a11y/noRedundantRoles forbids adding one.
    expect(html).toContain("<output");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
  });

  it("uses --color-ln-* tokens (citizen skin), never --color-ln-op-*", () => {
    useOnlineMock.mockReturnValue(false);
    const html = renderToStaticMarkup(<LnOfflineBanner />);
    expect(html).toMatch(/--color-ln-/);
    expect(html).not.toMatch(/--color-ln-op-/);
  });
});
