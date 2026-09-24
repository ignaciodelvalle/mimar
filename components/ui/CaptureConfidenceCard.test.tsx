// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CaptureConfidenceCard, type CaptureConfidenceLevel } from "./CaptureConfidenceCard";

afterEach(cleanup);

const fields = [
  { label: "Vacuna", value: "Antirrábica" },
  { label: "Fecha", value: "16/07/2026" },
];

describe("<CaptureConfidenceCard>", () => {
  it("renders the event type label and every field", () => {
    render(
      <CaptureConfidenceCard
        eventTypeLabel="Vacuna antirrábica"
        fields={fields}
        confidence="high"
        onConfirm={() => {}}
        onEdit={() => {}}
        confirmLabel="Asentar vacuna"
      />,
    );

    expect(screen.getByText("Vacuna antirrábica")).toBeTruthy();
    expect(screen.getByText("Vacuna")).toBeTruthy();
    expect(screen.getByText("Antirrábica")).toBeTruthy();
    expect(screen.getByText("Fecha")).toBeTruthy();
    expect(screen.getByText("16/07/2026")).toBeTruthy();
  });

  it("is a labeled ARIA region (role=region + aria-labelledby a real heading)", () => {
    render(
      <CaptureConfidenceCard
        eventTypeLabel="Vacuna antirrábica"
        fields={fields}
        confidence="high"
        onConfirm={() => {}}
        onEdit={() => {}}
        confirmLabel="Asentar vacuna"
      />,
    );

    const region = screen.getByRole("region", { name: "Vacuna antirrábica" });
    expect(region).toBeTruthy();
  });

  it("clicking the confirm button fires onConfirm and not onEdit", () => {
    const onConfirm = vi.fn();
    const onEdit = vi.fn();
    render(
      <CaptureConfidenceCard
        eventTypeLabel="Vacuna antirrábica"
        fields={fields}
        confidence="high"
        onConfirm={onConfirm}
        onEdit={onEdit}
        confirmLabel="Asentar vacuna"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Asentar vacuna" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("clicking the edit button fires onEdit and not onConfirm", () => {
    const onConfirm = vi.fn();
    const onEdit = vi.fn();
    render(
      <CaptureConfidenceCard
        eventTypeLabel="Vacuna antirrábica"
        fields={fields}
        confidence="high"
        onConfirm={onConfirm}
        onEdit={onEdit}
        confirmLabel="Asentar vacuna"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Editar en el formulario" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("supports custom confirm/edit labels", () => {
    render(
      <CaptureConfidenceCard
        eventTypeLabel="Vacuna antirrábica"
        fields={fields}
        confidence="high"
        onConfirm={() => {}}
        onEdit={() => {}}
        confirmLabel="Registrar"
        editLabel="Corregir"
      />,
    );

    expect(screen.getByRole("button", { name: "Registrar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Corregir" })).toBeTruthy();
  });

  const levels: Array<{ level: CaptureConfidenceLevel; text: string }> = [
    { level: "high", text: "Alta confianza" },
    { level: "medium", text: "Confianza media" },
    { level: "low", text: "Confianza baja" },
  ];

  for (const { level, text } of levels) {
    it(`confidence="${level}" renders "${text}" as visible TEXT (not color-only)`, () => {
      render(
        <CaptureConfidenceCard
          eventTypeLabel="Vacuna antirrábica"
          fields={fields}
          confidence={level}
          onConfirm={() => {}}
          onEdit={() => {}}
          confirmLabel="Asentar vacuna"
        />,
      );
      expect(screen.getByText(text)).toBeTruthy();
    });
  }

  it("uses ln-* design tokens and zero gob-* classes", () => {
    const { container } = render(
      <CaptureConfidenceCard
        eventTypeLabel="Vacuna antirrábica"
        fields={fields}
        confidence="medium"
        onConfirm={() => {}}
        onEdit={() => {}}
        confirmLabel="Asentar vacuna"
      />,
    );
    const html = container.innerHTML;
    expect(html).toMatch(/--color-ln-/);
    expect(html).not.toMatch(/\bgob-/);
  });
});
