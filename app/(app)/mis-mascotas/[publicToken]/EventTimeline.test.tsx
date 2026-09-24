/**
 * Regression test for the ANOTAR-icon-click net::ERR_ABORTED bug
 * (pet-document-redesign CRITICAL-1, verify-report #617 WARNING-1).
 *
 * Root cause (found via Playwright network instrumentation against the live
 * :3000 prod build, 4/4 repro): FlipCard (ADR-11) mounts the Libreta face
 * UNCONDITIONALLY, even while it is off-screen behind the Credencial face.
 * EventTimelineList's per-event <Link> had no `prefetch={false}`, so EVERY
 * row started prefetching the instant the page loaded — regardless of
 * whether the user ever flipped to Libreta. On a timeline with several
 * rows, that flood of concurrent background RSC prefetch fetches exhausted
 * the browser's per-origin connection pool, starving whatever real
 * navigation the user clicked first (any `?sheet=` action-row icon,
 * observed first via Anotar) and aborting it with net::ERR_ABORTED before
 * the URL/history ever committed — dialog never opened.
 *
 * This test is a structural regression guard (repo convention: no jsdom,
 * react-dom/server renderToStaticMarkup) asserting the row link is opted
 * out of Next.js's default eager prefetch. It cannot reproduce the network
 * race itself (that needs a real browser + real connection pool), but it
 * pins the fix so no one silently re-enables eager prefetch on this
 * always-mounted, often-invisible list.
 *
 * Pattern: react-dom/server renderToStaticMarkup (repo convention — no
 * jsdom); next/link mocked to surface the `prefetch` prop as a DOM
 * attribute so it's assertable from the static HTML string.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch,
    children,
    className,
  }: {
    href: string;
    prefetch?: boolean;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className, "data-prefetch": String(prefetch) }, children),
}));

import { type EventTimelineEvent, EventTimelineList } from "./EventTimeline";

const baseEvent: EventTimelineEvent = {
  id: "evt-1",
  eventType: "note_added",
  payload: { text: "hola" },
  occurredAt: new Date("2026-01-01T00:00:00Z"),
  notes: null,
  attachmentUrl: null,
};

describe("<EventTimelineList> — row link prefetch (regression for CRITICAL-1)", () => {
  it("opts the per-event detail link OUT of eager prefetch (prefetch={false})", () => {
    const html = renderToStaticMarkup(
      <EventTimelineList events={[baseEvent]} publicToken="abc123" />,
    );
    expect(html).toContain('href="/mis-mascotas/abc123/eventos/evt-1"');
    expect(html).toContain('data-prefetch="false"');
  });

  it("renders no link at all when publicToken is absent (unaffected by the fix)", () => {
    const html = renderToStaticMarkup(<EventTimelineList events={[baseEvent]} />);
    expect(html).not.toContain("<a");
  });
});

// ---------------------------------------------------------------------------
// 320px row-header stacking (live QA finding 6, engram #635): wrapped titles
// crowded the inline top-right timestamp. Structural sentinel — asserts the
// row header uses the repo's stack-then-row responsive pattern (flex-col by
// default, sm:flex-row from the sm breakpoint up) instead of always being a
// row, for both the linked (publicToken present) and unlinked row shapes.
// ---------------------------------------------------------------------------

describe("<EventTimelineList> — row header stacks the timestamp below the title at narrow widths", () => {
  it("linked row header (publicToken present) is flex-col by default, sm:flex-row above sm", () => {
    const html = renderToStaticMarkup(
      <EventTimelineList events={[baseEvent]} publicToken="abc123" />,
    );
    expect(html).toContain("flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between");
  });

  it("unlinked row header (no publicToken) is flex-col by default, sm:flex-row above sm", () => {
    const html = renderToStaticMarkup(<EventTimelineList events={[baseEvent]} />);
    expect(html).toContain("flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between");
  });
});

// ---------------------------------------------------------------------------
// WHO surfacing (C5, 2026-07-21 facades harvest): the citizen timeline
// previously rendered a confidence badge but never the actor's role, despite
// the operator ledger (EventLedgerRow) showing actor + timestamp from the
// SAME provenance fields. WHEN (occurredAt) was already unconditional; this
// pins WHO now renders too, via the shared, citizen-safe AuthorChip (role
// only — never a personal name).
// ---------------------------------------------------------------------------

describe("<EventTimelineList> — actor (who) surfacing", () => {
  it("renders the actor's role label when authorRole is present", () => {
    const html = renderToStaticMarkup(
      <EventTimelineList
        events={[{ ...baseEvent, authorRole: "shelter", authorVerified: true }]}
      />,
    );
    expect(html).toContain("Refugio");
  });

  it("renders no actor chip when authorRole is absent (legacy caller, e.g. the memorial view)", () => {
    const html = renderToStaticMarkup(<EventTimelineList events={[baseEvent]} />);
    // None of the AUTHOR_ROLE_LABELS es-AR strings should appear.
    expect(html).not.toContain("Dueño/a");
    expect(html).not.toContain("Veterinario/a");
    expect(html).not.toContain("Refugio");
  });

  it("shows the verified mark only when authorVerified is true", () => {
    const verifiedHtml = renderToStaticMarkup(
      <EventTimelineList events={[{ ...baseEvent, authorRole: "vet", authorVerified: true }]} />,
    );
    expect(verifiedHtml).toContain('aria-label="verificado"');

    const unverifiedHtml = renderToStaticMarkup(
      <EventTimelineList events={[{ ...baseEvent, authorRole: "vet", authorVerified: false }]} />,
    );
    expect(unverifiedHtml).not.toContain('aria-label="verificado"');
  });
});
