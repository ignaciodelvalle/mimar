// OutboxTable — shared outbox list table (Wave B systemic: /admin/outbox +
// /gob/outbox de-duplication). Verifies the two behavioral seams the pages
// inject via props:
//   - detailHrefFor → null renders an inert "—" cell (govt non-admin has no
//     scoped detail page); a non-null href renders the "Detalle" link.
//   - petTokenBySourceEventId links the source-event cell to /p/[token] (admin
//     resolves this; govt omits it → plain text).
//
// Uses renderToStaticMarkup (the repo's dependency-free component harness).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OutboxTable, type OutboxTableRow } from "@/components/ui/dashboard/OutboxTable";

const ROW: OutboxTableRow = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "pending",
  slaDueAt: new Date("2026-01-02T12:00:00.000Z"),
  targetKind: "govt_webhook",
  targetJurisdictionProvince: "Buenos Aires",
  targetJurisdictionLocality: "La Plata",
  sourceEventId: "abcdef12-3456-4789-8abc-def012345678",
  attempts: 1,
  createdAt: new Date("2026-01-01T12:00:00.000Z"),
};

describe("OutboxTable — detail link", () => {
  it("renders the detail link when detailHrefFor returns an href (admin)", () => {
    const html = renderToStaticMarkup(
      <OutboxTable rows={[ROW]} caption="c" detailHrefFor={(r) => `/admin/outbox/${r.id}`} />,
    );
    expect(html).toContain(`href="/admin/outbox/${ROW.id}"`);
    expect(html).toContain("Detalle");
  });

  it("renders an inert dash when detailHrefFor returns null (govt non-admin)", () => {
    const html = renderToStaticMarkup(
      <OutboxTable rows={[ROW]} caption="c" detailHrefFor={() => null} />,
    );
    expect(html).not.toContain(`href="/admin/outbox/${ROW.id}"`);
    expect(html).not.toContain("Detalle");
  });
});

// PO observation (/gob/outbox, 2026-07-26): the "Intentos" column looked blank
// on EVERY row, including the ones flagged as SLA breaches. Diagnosis: the data
// is not missing — `event_notification_outbox.attempts` is NOT NULL DEFAULT 0
// and every row in the local stack reads 0 (the drainer has never run against
// this data). What the column rendered for 0 was a muted "—", which at 13px in
// a mute tone is indistinguishable from an empty cell.
//
// "—" is also the WRONG symbol here: it is the repo's "no value" glyph, and this
// is not a missing value, it is a meaningful zero — nobody has tried to deliver
// this notification yet. On a breached row that is the single most important
// fact in it. Say it in words.
describe("OutboxTable — Intentos states a real zero instead of looking blank", () => {
  it("says 'Sin intentos' when the drainer never touched the row", () => {
    const html = renderToStaticMarkup(
      <OutboxTable rows={[{ ...ROW, attempts: 0 }]} caption="c" detailHrefFor={() => null} />,
    );
    // As VISIBLE TEXT, not as a title= tooltip — the old cell already carried
    // `title="Sin intentos de entrega todavía"` on an em dash, which is exactly
    // the kind of assertion that stays green while the screen stays blank.
    expect(html).toContain(">Sin intentos<");
  });

  it("never renders a bare em dash for a zero-attempt row", () => {
    const html = renderToStaticMarkup(
      <OutboxTable
        rows={[
          {
            ...ROW,
            attempts: 0,
            targetJurisdictionProvince: null,
            targetJurisdictionLocality: null,
          },
        ]}
        caption="c"
        detailHrefFor={() => `/admin/outbox/${ROW.id}`}
      />,
    );
    // The jurisdiction cell legitimately dashes when both parts are null; the
    // attempts cell must not add a second, meaningless one.
    //
    // Counts a cell whose ENTIRE content is an em dash, not every em dash in
    // the document (2026-08-04): honest status wording now legitimately
    // contains one mid-sentence — "Registrada y auditada — envío al webhook
    // pendiente de receptor" — and a document-wide count made this fence fire
    // on copy that is not a blank cell at all. This is the stricter assertion,
    // not the looser one: it names the thing the test is actually about.
    const bareDashCells = html.match(/>—</g) ?? [];
    expect(bareDashCells).toHaveLength(1);
  });

  it("still shows the count once there is one", () => {
    const html = renderToStaticMarkup(
      <OutboxTable rows={[{ ...ROW, attempts: 3 }]} caption="c" detailHrefFor={() => null} />,
    );
    expect(html).toContain(">3<");
    expect(html).not.toContain("Sin intentos");
  });
});

describe("OutboxTable — source-event → pet link", () => {
  it("links the source-event cell to the pet page when a token is supplied (admin)", () => {
    const map = new Map<string, string>([[ROW.sourceEventId, "DIM-CCCC-DDDD"]]);
    const html = renderToStaticMarkup(
      <OutboxTable
        rows={[ROW]}
        caption="c"
        petTokenBySourceEventId={map}
        detailHrefFor={() => null}
      />,
    );
    expect(html).toContain('href="/p/DIM-CCCC-DDDD"');
  });

  it("renders plain source-event text when no token map is supplied (govt)", () => {
    const html = renderToStaticMarkup(
      <OutboxTable rows={[ROW]} caption="c" detailHrefFor={() => null} />,
    );
    expect(html).not.toContain("/p/");
    // The first 8 chars of the source event id are still shown as mono text.
    expect(html).toContain(ROW.sourceEventId.slice(0, 8));
  });
});
