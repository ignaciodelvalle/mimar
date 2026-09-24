// chip-radius-doctrine — la geometría de la familia de chips, escrita donde CI
// la puede leer (E-2, 2026-08-10).
//
// POR QUÉ EXISTE. E-2 reportó "el radio de chip no tiene 5 valores: tiene 6
// geometrías" barriendo los archivos cuyo NOMBRE contiene
// chip|badge|pill|tag|flag|crumb. Tres de esas seis no eran chips:
//
//   · `rounded-[1px]` (Chip.tsx) es el PUNTO de estado "perdida" — la forma es
//     la codificación redundante no-cromática para daltonismo. Volverlo píldora
//     borraría una affordance de accesibilidad, no unificaría nada.
//   · `rounded-lg` (GovtJurisdictionsChip) es el PANEL desplegable del chip, no
//     el chip. 8px sobre una superficie es el token correcto.
//   · `rounded-2xl` (PppPublicBadge) es una TARJETA con encabezado y cuerpo.
//
// Es la misma clase de defecto que esta corrida encontró una y otra vez: una
// medición que declara una propiedad más angosta que la que su nombre promete.
// Este test fija lo que quedó cuando se saca el ruido, para que la próxima
// auditoría discuta contra hechos y no vuelva a contar seis.
//
// LA DOCTRINA (decisión del PO X2-S2, 2026-07-29, en app/globals.css:138-153):
// dos niveles, y sólo dos. Ciudadano → píldora. Operador → rectángulo
// institucional. Converger el nivel operador a píldora NO es unificar: es
// revertir una decisión tomada, y borraría la señal que distingue una pantalla
// de trámite de una consola de trabajo.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const GLOBALS = read("app/globals.css");

describe("radios de la familia de chips — la doctrina de dos niveles", () => {
  it("los dos tokens de nivel existen y valen lo que la doctrina dice", () => {
    // Si alguno dejara de valer esto, cada aserción de abajo pasaría a probar
    // otra cosa sin fallar. El ancla va primero, como en citizen-cta-radius.
    expect(GLOBALS).toMatch(/--radius-pill:\s*9999px/);
    expect(GLOBALS).toMatch(/--radius-op-chip:\s*3px/);
    expect(GLOBALS).toMatch(/--radius-op-btn:\s*6px/);
  });

  it("el chip de operador sale de un token, no de un píxel escrito a mano", () => {
    // Cuatro sitios tipeaban `rounded-[3px]` por separado. El valor no cambia;
    // lo que cambia es que ahora se mueve desde un lugar.
    const sites = [
      "components/ui/dashboard/OpStatusPill.tsx",
      "components/ui/dashboard/OpPill.tsx",
      "components/ui/dashboard/OpCodeBadge.tsx",
      "app/gob/vigilancia/investigaciones/[caseCode]/page.tsx",
    ];
    for (const site of sites) {
      const src = read(site);
      expect(src, `${site} debería usar el token del chip de operador`).toContain(
        "rounded-[var(--radius-op-chip)]",
      );
      // `gap-[3px]` es espaciado, no radio: la regla mira sólo `rounded-`.
      expect(src, `${site} no debería tipear el radio a mano`).not.toMatch(/rounded-\[3px\]/);
    }
  });

  it("ningún chip de operador usa la píldora del nivel ciudadano", () => {
    // La prueba de que la doctrina sigue en pie por el lado que E-2 quería
    // borrar. Un `rounded-full` acá sería el primer paso de la convergencia que
    // la decisión X2-S2 rechazó.
    for (const site of [
      "components/ui/dashboard/OpStatusPill.tsx",
      "components/ui/dashboard/OpPill.tsx",
      "components/ui/dashboard/OpCodeBadge.tsx",
    ]) {
      expect(read(site), `${site} es nivel operador: rectángulo, no píldora`).not.toMatch(
        /rounded-(full|\[var\(--radius-pill\)\])/,
      );
    }
  });

  it("el punto de estado 'perdida' conserva su forma cuadrada", () => {
    // NO es un radio que sobró: es la codificación no-cromática que hace que
    // "perdida" se distinga de "enferma" sin depender del color.
    const chip = read("components/ui/Chip.tsx");
    expect(chip).toMatch(/lost:\s*"[^"]*rounded-\[1px\]/);
    expect(chip).toMatch(/sick:\s*"[^"]*rounded-\[var\(--radius-xs\)\]/);
  });

  it("las superficies con contenido usan radio de tarjeta, aunque se llamen Badge", () => {
    const ppp = read("components/PppPublicBadge.tsx");
    expect(ppp).toContain("rounded-[var(--radius-card)]");
    // Sobre los `className`, no sobre el archivo: el comentario que explica el
    // cambio NOMBRA el valor viejo, y una aserción sobre el texto entero se
    // rompería contra su propia prosa (lo hizo, la primera vez que corrió).
    const classNames = [...ppp.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
    expect(
      classNames.filter((c) => c.includes("rounded-2xl")),
      "rounded-2xl era el valor correcto escrito como utilidad cruda",
    ).toEqual([]);
  });
});
