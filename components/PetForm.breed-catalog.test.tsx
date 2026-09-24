// @vitest-environment jsdom
//
// PetForm — la raza salió del texto libre y pasó a catálogo (PO, 2026-08-13).
//
// Medido en staging ese día: 69 mascotas con raza, 44 valores distintos, 34
// usados una sola vez. Y una fila "Pit Bull Terrier Americano" SIN marcar como
// PPP, mientras un perro idéntico en otro barrio de la misma ciudad sí lo
// estaba, bajo la misma ley. Lo que decidía si el régimen alcanzaba a un animal
// era la ortografía del dueño.
//
// El riesgo del cambio no es la UI, es el DATO: un <select> cuyo value no
// matchea ninguna <option> se renderiza vacío, y el próximo guardado borra una
// raza que ya estaba registrada. Un arreglo de calidad de datos que pierde datos
// es peor que el problema. Eso es lo que fija el segundo bloque.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: () => Promise.resolve([]),
  searchLocalitiesPublicAction: () => Promise.resolve([]),
}));

import { PetForm } from "@/components/PetForm";
import type { Pet } from "@/db";

const noopAction = async () => ({ error: null });

function renderWithPet(pet: Partial<Pet>) {
  return render(<PetForm action={noopAction} existingPet={{ species: "dog", ...pet } as Pet} />);
}

afterEach(cleanup);

describe("la raza es una selección, no texto libre", () => {
  it("el campo ya no acepta texto tipeado", () => {
    // Se afirma sobre el DOM renderizado y no sobre el código fuente: la primera
    // versión de este test buscaba `list="breed-options"` en el archivo y falló
    // matcheando el COMENTARIO que explica el cambio. Un test que lee prosa mide
    // prosa.
    renderWithPet({ breed: "" });
    const control = screen.getByLabelText(/raza/i);
    expect(control.tagName).toBe("SELECT");
    // Sólo el datalist DE RAZA tiene que haber desaparecido. Otros campos del
    // formulario (aseguradora, comidas, color) siguen con datalist a propósito:
    // son texto libre que nadie compara, y encorsetarlos sería fricción sin
    // beneficio. El criterio es "¿algo compara este campo?", no "¿es una lista?".
    expect(control.getAttribute("list")).toBeNull();
    expect(document.querySelector("#breed-options")).toBeNull();
  });

  it("ofrece las razas del catálogo de la especie", () => {
    renderWithPet({ breed: "" });
    const select = screen.getByLabelText(/raza/i);
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(options).toContain("American Pit Bull Terrier");
    expect(options).toContain("Mixto / Cruza");
  });
});

describe("no perder razas ya cargadas", () => {
  it("conserva un valor histórico que NO está en el catálogo", () => {
    // La fila real encontrada en staging.
    renderWithPet({ breed: "Pit Bull Terrier Americano" });
    const select = screen.getByLabelText(/raza/i) as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);

    expect(options).toContain("Pit Bull Terrier Americano");
    // Y sigue SELECCIONADO: si quedara vacío, el próximo guardado borra la raza.
    expect(select.value).toBe("Pit Bull Terrier Americano");
  });

  it("no duplica la opción cuando el valor histórico sí está en el catálogo", () => {
    renderWithPet({ breed: "Rottweiler" });
    const select = screen.getByLabelText(/raza/i);
    const rott = Array.from(select.querySelectorAll("option")).filter(
      (o) => o.value === "Rottweiler",
    );
    expect(rott).toHaveLength(1);
  });
});

describe("el aviso de raza peligrosa concuerda con la clasificación", () => {
  it("avisa sobre un valor histórico que el matcher SÍ resuelve a PPP", () => {
    // Antes el aviso comparaba con igualdad exacta, así que podía callarse sobre
    // un perro que el servidor sí clasifica. Un aviso que discrepa de la
    // clasificación es peor que ninguno: el dueño lo lee como confirmación de
    // que el régimen no le aplica.
    renderWithPet({ breed: "Pit Bull Terrier Americano" });
    expect(screen.getByText(/raza potencialmente peligrosa/i)).toBeInTheDocument();
  });

  it("no avisa sobre una raza que no es PPP", () => {
    renderWithPet({ breed: "Beagle" });
    expect(screen.queryByText(/raza potencialmente peligrosa/i)).not.toBeInTheDocument();
  });
});
