/**
 * Tests for OpCallout — the Op-skin (operator) equivalent of LnEmptyState,
 * used inline as an empty-state fallback (e.g. /admin/observaciones' "Sin
 * observaciones") as well as a generic info callout.
 *
 * Coverage: the `nature` prop (C4, 2026-07-22 — plan-maestro-integridad
 * §C4). Default/`measured-zero` keeps the existing navy/info treatment;
 * `nature="no-signal"` renders a muted-warn treatment instead — never the
 * calm navy/info look — so a silent surveillance surface can't read as
 * "todo tranquilo".
 *
 * Pattern: renderToStaticMarkup (repo convention — no jsdom, no DB).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Icon } from "@/components/Icon";
import { OpCallout } from "@/components/ui/dashboard/OpCallout";

describe("<OpCallout> — epistemic nature", () => {
  it("omitting `nature` keeps the default navy/info treatment", () => {
    const html = renderToStaticMarkup(
      <OpCallout title="Sin localidades asignadas" icon={<Icon name="alerta" decorative />} />,
    );
    expect(html).toContain("bg-ln-op-navy");
    expect(html).toContain("bg-ln-op-card");
    expect(html).not.toMatch(/ln-op-warn/);
    expect(html).not.toContain('role="status"');
  });

  it('nature="measured-zero" renders identically to the default (a real, verified zero)', () => {
    const withNature = renderToStaticMarkup(
      <OpCallout title="Sin localidades asignadas" nature="measured-zero" />,
    );
    const withoutNature = renderToStaticMarkup(<OpCallout title="Sin localidades asignadas" />);
    expect(withNature).toBe(withoutNature);
  });

  it('nature="no-signal" renders a muted-warn treatment, never the navy/info look', () => {
    const html = renderToStaticMarkup(
      <OpCallout
        title="Sin observaciones registradas en MiMAR"
        body="La ausencia de observaciones no implica ausencia de casos por escalar."
        nature="no-signal"
      />,
    );
    expect(html).toMatch(/ln-op-warn/);
    expect(html).not.toContain("bg-ln-op-navy");
    expect(html).not.toContain('text-ln-op-ink">');
  });

  it('nature="no-signal" sets role="status"', () => {
    const html = renderToStaticMarkup(
      <OpCallout title="Sin observaciones registradas en MiMAR" nature="no-signal" />,
    );
    expect(html).toContain('role="status"');
  });

  it('nature="no-signal" tints the icon box with the warn token, not navy', () => {
    const html = renderToStaticMarkup(
      <OpCallout
        title="Sin observaciones registradas en MiMAR"
        nature="no-signal"
        icon={<Icon name="eye-off" decorative />}
      />,
    );
    expect(html).toContain("bg-ln-op-warn");
    expect(html).not.toContain("bg-ln-op-navy");
  });

  it("the blind-not-calm copy pattern never reads as success/ok", () => {
    const html = renderToStaticMarkup(
      <OpCallout
        title="Sin observaciones registradas en MiMAR"
        body="La ausencia de observaciones no implica ausencia de casos por escalar — revisá la brecha de escalamiento en Vigilancia."
        nature="no-signal"
      />,
    );
    expect(html).toContain("no implica ausencia de");
    expect(html).not.toMatch(/todo tranquilo|bajo control|sin problemas/i);
  });
});
