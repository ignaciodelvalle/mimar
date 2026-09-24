// Tests for <IdentityPendingBanner> — the return path out of an abandoned
// signup step 2 (staging finding 2026-08-01).
//
// The banner is the whole recovery story for the accounts that already exist,
// so the contract worth pinning is narrow and behavioural:
//   - it renders ONLY when the server says identity is pending;
//   - it carries the user back to where they were (returnTo, encoded);
//   - it has no way to dismiss it.
//
// Pattern: renderToStaticMarkup, same as EmptyState.test.tsx.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { IdentityPendingBanner } from "./IdentityPendingBanner";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("<IdentityPendingBanner>", () => {
  it("renders nothing when identity is complete", () => {
    expect(render(<IdentityPendingBanner pending={false} returnTo="/mis-mascotas" />)).toBe("");
  });

  it("renders the prompt when identity is still provisional", () => {
    const html = render(<IdentityPendingBanner pending returnTo="/mis-mascotas" />);

    expect(html).toContain("Falta tu nombre");
    expect(html).toContain("Completar mi perfil");
  });

  it("links to the signup resume surface carrying the current page as returnTo", () => {
    const html = render(<IdentityPendingBanner pending returnTo="/mis-mascotas" />);

    expect(html).toContain('href="/registro?returnTo=%2Fmis-mascotas"');
  });

  it("percent-encodes a returnTo that carries a query string", () => {
    // A raw "?" here would truncate returnTo and silently drop the user on
    // /mis-mascotas after completing their profile.
    const html = render(<IdentityPendingBanner pending returnTo="/mis-mascotas?tab=inbox" />);

    expect(html).toContain('href="/registro?returnTo=%2Fmis-mascotas%3Ftab%3Dinbox"');
  });

  it("offers no way to dismiss itself", () => {
    // Deliberate: the state it reports is a real gap in a national registry
    // record, and it clears itself the moment the real name is saved. A close
    // button would let it be silenced while the record stays broken.
    const html = render(<IdentityPendingBanner pending returnTo="/mis-mascotas" />);

    expect(html).not.toContain("<button");
    expect(html.toLowerCase()).not.toContain("cerrar");
    expect(html).not.toContain("dismiss");
  });
});
