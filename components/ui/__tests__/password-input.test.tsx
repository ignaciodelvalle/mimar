// @vitest-environment jsdom
//
// LnPasswordInput — hallazgo U5 de la crítica de diseño del 2026-07-27:
// "sin toggle mostrar contraseña, el no-técnico tipea a ciegas en el teléfono
// y falla más". Estos tests fijan lo que un toggle mal hecho rompería.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { LnPasswordInput } from "../Field";

afterEach(() => cleanup());

it("arranca oculto y revela al tocar el botón", () => {
  render(<LnPasswordInput aria-label="Contraseña" defaultValue="secreta" />);
  const input = screen.getByLabelText("Contraseña") as HTMLInputElement;
  expect(input.type).toBe("password");

  fireEvent.click(screen.getByRole("button", { name: "Mostrar contraseña" }));
  expect(input.type).toBe("text");

  fireEvent.click(screen.getByRole("button", { name: "Ocultar contraseña" }));
  expect(input.type).toBe("password");
});

it("el botón es type=button — un botón sin type dentro de un form ENVÍA el form", () => {
  render(<LnPasswordInput aria-label="Contraseña" />);
  expect(screen.getByRole("button")).toHaveAttribute("type", "button");
});

it("anuncia el estado con aria-pressed, sin cambiar el nombre bajo el foco", () => {
  render(<LnPasswordInput aria-label="Contraseña" />);
  const btn = screen.getByRole("button");
  expect(btn).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(btn);
  expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
});

it("dos campos en el mismo formulario se revelan de forma independiente", () => {
  render(
    <>
      <LnPasswordInput aria-label="Nueva" />
      <LnPasswordInput aria-label="Repetir" />
    </>,
  );
  const nueva = screen.getByLabelText("Nueva") as HTMLInputElement;
  const repetir = screen.getByLabelText("Repetir") as HTMLInputElement;
  fireEvent.click(screen.getAllByRole("button")[0]);
  expect(nueva.type).toBe("text");
  expect(repetir.type).toBe("password");
});
