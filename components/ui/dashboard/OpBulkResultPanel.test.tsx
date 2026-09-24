// Smoke tests for <OpBulkResultPanel>.
// Pattern: renderToStaticMarkup (see components/ui/EmptyState.test.tsx).

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BulkResult } from "@/app/actions/bulk-actions";
import { OpBulkResultPanel } from "./OpBulkResultPanel";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

function makeResult(overrides: Partial<BulkResult> = {}): BulkResult {
  return {
    bulkActionId: "bulk-123",
    succeeded: ["a", "b"],
    failed: [{ id: "cccccccc-1111-2222-3333-444444444444", reason: "fuera de alcance" }],
    ...overrides,
  };
}

describe("<OpBulkResultPanel>", () => {
  it("uses the default 'OK' label and renders failed ids in full when untruncated", () => {
    const html = render(<OpBulkResultPanel result={makeResult()} onDismiss={() => {}} />);
    expect(html).toContain("2 OK · 1 fallaron");
    expect(html).toContain("cccccccc-1111-2222-3333-444444444444");
    expect(html).toContain("fuera de alcance");
  });

  it("uses a custom successLabel in the summary line", () => {
    const html = render(
      <OpBulkResultPanel result={makeResult()} onDismiss={() => {}} successLabel="vacunadas" />,
    );
    expect(html).toContain("2 vacunadas · 1 fallaron");
  });

  it("truncates failed ids to truncateFailedIdsTo chars, followed by an ellipsis", () => {
    const html = render(
      <OpBulkResultPanel result={makeResult()} onDismiss={() => {}} truncateFailedIdsTo={8} />,
    );
    expect(html).toContain("cccccccc…");
    expect(html).not.toContain("cccccccc-1111-2222-3333-444444444444");
  });

  it("renders the bulk: footer line with the bulkActionId", () => {
    const html = render(<OpBulkResultPanel result={makeResult()} onDismiss={() => {}} />);
    expect(html).toContain("bulk: bulk-123");
  });

  it("does NOT render a <ul> when there are zero failures", () => {
    const html = render(
      <OpBulkResultPanel result={makeResult({ failed: [] })} onDismiss={() => {}} />,
    );
    expect(html).not.toContain("<ul");
    expect(html).toContain("2 OK · 0 fallaron");
  });

  it("uses ln-op-* tokens, no non-op ln-* status tones, and no legacy gob-", () => {
    const html = render(<OpBulkResultPanel result={makeResult()} onDismiss={() => {}} />);
    // This surface uses the mapped `ln-op-*` Tailwind utility form (e.g.
    // border-ln-op-line, bg-ln-op-card) rather than the arbitrary
    // `[var(--color-ln-op-*)]` bracket form — both are valid `lint:tokens`
    // token usage, but only the mapped form is literally present in SSR
    // markup, so assert on that prefix directly.
    expect(html).toMatch(/\bln-op-/);
    expect(html).not.toMatch(/\bgob-/);
  });
});
