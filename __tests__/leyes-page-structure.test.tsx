/**
 * Structural tests for /leyes (public legal knowledge base).
 *
 * Pattern: react-dom/server renderToStaticMarkup (repo convention — no jsdom,
 * see __tests__/a11y-structural.test.tsx). Verifies the accordion renders as
 * <details>/<summary> (native, no-JS progressive disclosure) with one entry
 * per catalog item, and that the content module drives the render (not
 * hardcoded copy that could drift from lib/reference/legal-knowledge-base.ts).
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

import LeyesPage from "@/app/(public)/leyes/page";
import {
  LEGAL_KNOWLEDGE_GROUPS,
  getAllLegalKnowledgeEntries,
} from "@/lib/reference/legal-knowledge-base";

describe("LeyesPage — structure", () => {
  it("renders one <details> accordion per catalog entry", () => {
    const html = renderToStaticMarkup(<LeyesPage />);
    const detailsCount = (html.match(/<details/g) ?? []).length;
    expect(detailsCount).toBe(getAllLegalKnowledgeEntries().length);
  });

  it("renders a <summary> for every <details>", () => {
    const html = renderToStaticMarkup(<LeyesPage />);
    const detailsCount = (html.match(/<details/g) ?? []).length;
    const summaryCount = (html.match(/<summary/g) ?? []).length;
    expect(summaryCount).toBe(detailsCount);
  });

  it("renders every group heading and every law label", () => {
    const html = renderToStaticMarkup(<LeyesPage />);
    for (const group of LEGAL_KNOWLEDGE_GROUPS) {
      expect(html).toContain(group.title);
    }
    for (const entry of getAllLegalKnowledgeEntries()) {
      expect(html).toContain(entry.lawLabel);
    }
  });

  it("renders a back-to-home link", () => {
    const html = renderToStaticMarkup(<LeyesPage />);
    expect(html).toMatch(/<a href="\/"[^>]*>/);
  });

  it("renders external source links with rel=noopener noreferrer", () => {
    const html = renderToStaticMarkup(<LeyesPage />);
    const externalLinkMatches = html.match(/<a href="https:\/\/[^"]*"[^>]*>/g) ?? [];
    expect(externalLinkMatches.length).toBeGreaterThan(0);
    for (const tag of externalLinkMatches) {
      expect(tag).toContain('target="_blank"');
      expect(tag).toContain("noopener");
      expect(tag).toContain("noreferrer");
    }
  });
});
