// Smoke tests for <OpOfflineBanner>.
// Pattern: renderToStaticMarkup (see components/ui/OfflineBanner.test.tsx —
// the Ln sibling this mirrors). useOnline() is mocked so the SSR render can
// control the offline/online state directly.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { useOnlineMock } = vi.hoisted(() => ({ useOnlineMock: vi.fn() }));
vi.mock("@/lib/hooks/useOnline", () => ({ useOnline: useOnlineMock }));

import { OpOfflineBanner } from "./OpOfflineBanner";

const OFFLINE_COPY =
  "Sin conexión — revisá tu internet. Los cambios no se van a guardar hasta que vuelva la conexión.";

describe("<OpOfflineBanner>", () => {
  it("renders nothing when online", () => {
    useOnlineMock.mockReturnValue(true);
    const html = renderToStaticMarkup(<OpOfflineBanner />);
    expect(html).toBe("");
  });

  it("renders the exact offline copy when offline", () => {
    useOnlineMock.mockReturnValue(false);
    const html = renderToStaticMarkup(<OpOfflineBanner />);
    expect(html).toContain(OFFLINE_COPY);
  });

  it('renders an <output> with aria-live="polite" (implicit status role — informational, not an alert)', () => {
    useOnlineMock.mockReturnValue(false);
    const html = renderToStaticMarkup(<OpOfflineBanner />);
    // <output>'s implicit ARIA role is "status" (same idiom as DemoModeBanner)
    // — no explicit role="status" attribute needed, and biome's
    // lint/a11y/noRedundantRoles forbids adding one.
    expect(html).toContain("<output");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
  });

  it("uses --color-ln-op-* tokens (operator skin)", () => {
    useOnlineMock.mockReturnValue(false);
    const html = renderToStaticMarkup(<OpOfflineBanner />);
    expect(html).toMatch(/--color-ln-op-/);
  });
});
