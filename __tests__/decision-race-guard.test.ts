// Una decisión de autoridad no puede pisar a otra.
//
// EL DEFECTO
// ---------------------------------------------------------------------------
// `approveRequestForAuthority` y `rejectRequestForAuthority` verificaban
// `request.status !== "pending"` con una lectura hecha ANTES de abrir la
// transacción, y después actualizaban con `WHERE id = …` a secas. Dos
// operadores sobre la misma solicitud —uno aprobando, otro rechazando desde una
// pestaña vieja— pasaban los dos ese chequeo y escribían los dos.
//
// La consecuencia no es cosmética. La aprobación de una matrícula muta el
// perfil ANTES de tocar la solicitud (`role: "vet"`, `matriculaVerified: true`).
// Si el rechazo commiteaba después, pisaba el `status` sin revertir nada:
// quedaba un veterinario con privilegio de firma clínica activo cuya solicitud
// figuraba "rechazada", y la única forma de notarlo era cruzar dos filas
// contradictorias de `audit_log`.
//
// QUÉ PRUEBA ESTE ARCHIVO Y QUÉ NO
// ---------------------------------------------------------------------------
// No corre la carrera. Un test que dispara dos transacciones y espera que se
// entrelacen pasa casi siempre por suerte, no por corrección — sería la clase
// de verde decorativo que este repo viene sacándose de encima. Lo que sí es
// verificable de forma determinista es la GUARDA: que la condición de estado
// viaje dentro del `WHERE` del UPDATE y que el resultado se controle. Sin eso,
// la carrera vuelve; con eso, el perdedor actualiza cero filas y aborta, y el
// rollback deshace la mutación del perfil porque ocurrió en la misma
// transacción.
//
// El patrón de referencia es `cases-repository.ts::closeCase`, que ya lo hace
// así y explica en su propio comentario que quien pierde la carrera no debe
// seguir.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

const DECISIONES = [
  {
    file: "src/modules/organizations/application/admin-decisions/approve-request.ts",
    estado: "approved",
  },
  {
    file: "src/modules/organizations/application/admin-decisions/reject-request.ts",
    estado: "rejected",
  },
] as const;

function fuente(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

describe("las decisiones de autoridad no se pisan entre sí", () => {
  it("lee ambos archivos", () => {
    // NO VACUIDAD: un archivo movido dejaría todo lo de abajo pasando sobre
    // una cadena vacía.
    for (const { file } of DECISIONES) {
      expect(fuente(file).length, file).toBeGreaterThan(1000);
    }
  });

  it("condiciona el UPDATE a que la solicitud siga pendiente", () => {
    // La mitad que cierra la carrera. Sin esta condición el perdedor
    // sobrescribe la decisión del ganador.
    const sinGuarda: string[] = [];
    for (const { file } of DECISIONES) {
      const src = fuente(file);
      const tieneGuarda =
        /\.update\(approvalRequests\)[\s\S]{0,600}?eq\(approvalRequests\.status,\s*"pending"\)/.test(
          src,
        );
      if (!tieneGuarda) sinGuarda.push(file);
    }
    expect(sinGuarda).toEqual([]);
  });

  it("aborta cuando no actualizó ninguna fila", () => {
    // La otra mitad, y la que de verdad protege el perfil: una guarda que no se
    // mira no sirve de nada. El throw dentro de la transacción es lo que
    // revierte la mutación ya aplicada.
    const sinChequeo: string[] = [];
    for (const { file } of DECISIONES) {
      const src = fuente(file);
      const chequea =
        /\.returning\(/.test(src) && /\.length === 0\)\s*\{[\s\S]{0,200}?throw new Error/.test(src);
      if (!chequea) sinChequeo.push(file);
    }
    expect(sinChequeo).toEqual([]);
  });

  it("escribe cada estado terminal solo desde su propio archivo", () => {
    // Guarda de cordura sobre la tabla de arriba: si alguien intercambia los
    // archivos, las dos aserciones anteriores seguirían pasando mientras el
    // test dejaría de describir lo que dice describir.
    for (const { file, estado } of DECISIONES) {
      expect(fuente(file), file).toContain(`status: "${estado}"`);
    }
  });
});
