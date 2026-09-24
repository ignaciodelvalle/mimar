// e2e-sign-in-route — nadie vuelve a escribir la ruta de ingreso a mano.
//
// EL DEFECTO QUE ESTE TEST EXISTE PARA EVITAR. El 2026-08-08 las rutas de auth
// se mudaron a castellano (`/login` → `/iniciar-sesion`) y `app/(auth)/login`
// quedó como 308 permanente. Seis specs de e2e tenían su propia copia de
//
//     (url) => !url.pathname.startsWith("/login")
//
// como predicado de "ya salí del login". Después del 308 el navegador está en
// `/iniciar-sesion`, que NO empieza con `/login`: el predicado pasó a ser
// verdadero ANTES de que se tipeara una credencial. `loginAs` daba el ingreso
// por exitoso y cacheaba cookies anónimas para todo el worker. Resultado: 45
// tests en rojo en un solo run de CI, todos con la misma forma —"expected
// /admin, but the browser is on /iniciar-sesion".
//
// Ni un test se puso rojo por el cambio de ruta: uno se puso VERDE por el motivo
// equivocado y arrastró a los demás. Este fence corre en el gate rápido (vitest,
// no Playwright), así que la próxima mudanza de ruta falla en segundos y no
// después de 29 minutos de e2e.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SIGN_IN_PATH, isSignInPath, leftSignIn } from "../e2e/_sign-in-route";

const E2E_DIR = join(process.cwd(), "e2e");
/** El módulo que DEFINE la ruta es el único autorizado a nombrarla en crudo. */
const OWNER = "_sign-in-route.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(E2E_DIR).filter((f) => !f.endsWith(OWNER));

/**
 * Las líneas que son CÓDIGO — se descartan las de comentario entero.
 *
 * La prosa SÍ puede nombrar `/login`, y conviene que lo haga: media docena de
 * comentarios de este repo explican por qué la ruta se movió y qué se rompió
 * cuando lo hizo. Prohibirla ahí borraría la historia que evita repetir el
 * error. Lo que no puede nombrarla es una línea que se ejecuta.
 *
 * Se descartan sólo comentarios de línea completa (`//`, `/*`, `*`), no los de
 * cola: en `goto("/login") // legacy` la parte de código sigue delatándose.
 */
function codeLines(src: string): string[] {
  return src.split("\n").filter((line) => {
    const t = line.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  });
}

describe("la ruta de ingreso vive en un solo lugar", () => {
  it("el barrido encuentra archivos (si no, este test no prueba nada)", () => {
    // Piso de no-vacuidad: un walk() roto dejaría FILES vacío y las dos reglas
    // de abajo pasarían sin mirar una línea. El repo tiene ~40 archivos .ts en
    // e2e/; 20 es holgado y sigue siendo un piso real.
    expect(FILES.length).toBeGreaterThan(20);
  });

  it("ningún archivo de e2e nombra /login, en NINGUNA sintaxis", () => {
    // ESTA REGLA EMPEZÓ SIENDO MÁS ANGOSTA QUE SU PROPIO NOMBRE, y por eso se
    // escribe así. La primera versión buscaba dos formas concretas —
    // `pathname.startsWith("/login")` y `.goto("/login")`— y dejó pasar una
    // tercera que estaba a la vista en dos archivos:
    //
    //     .not.toMatch(/^\/login/)
    //
    // Un literal de expresión regular, no un string. `/iniciar-sesion` tampoco
    // matchea ESA, así que el poll se cumplía parado en el formulario y
    // `stateFor` cacheaba un storageState ANÓNIMO para los doce tests del
    // archivo. La reja pasó verde sobre el defecto que existía para atrapar.
    //
    // La lección, que es la de toda esta corrida: una reja que enumera formas
    // sólo atrapa las formas que enumeró. Enumerar la RUTA es exhaustivo;
    // enumerar las maneras de escribirla, nunca. Por eso ahora se prohíbe la
    // cadena, y el único módulo autorizado a nombrarla está excluido arriba.
    // `(?<![\w-])` en vez de enumerar los caracteres que pueden precederla:
    // enumerar comillas y barras dejó afuera el literal de regex `/^\/login/`,
    // donde lo que precede es una CONTRABARRA. Prohibir el segmento y no sus
    // envoltorios es lo único exhaustivo. El `\b` final deja pasar
    // `/logins-antiguos`, que es otra ruta.
    const LOGIN_LITERAL = /(?<![\w-])\/login\b/;
    const offenders = FILES.filter((f) =>
      codeLines(readFileSync(f, "utf8")).some((l) => LOGIN_LITERAL.test(l)),
    ).map((f) => f.slice(E2E_DIR.length + 1));

    expect(
      offenders,
      "importá SIGN_IN_PATH / LEGACY_SIGN_IN_PATH / leftSignIn de e2e/_sign-in-route en vez de escribir /login: /iniciar-sesion no empieza con /login ni matchea /^\\/login/, así que toda condición basada en esa cadena es verdadera estando parado en el formulario",
    ).toEqual([]);
  });

  it("la regla anterior reconoce las tres formas que ya aparecieron", () => {
    // Piso de no-vacuidad con dientes: si el patrón se afloja, esto falla antes
    // de que un defecto real se cuele. Son las tres formas VIVAS que tuvo este
    // bug, no ejemplos inventados.
    // `(?<![\w-])` en vez de enumerar los caracteres que pueden precederla:
    // enumerar comillas y barras dejó afuera el literal de regex `/^\/login/`,
    // donde lo que precede es una CONTRABARRA. Prohibir el segmento y no sus
    // envoltorios es lo único exhaustivo. El `\b` final deja pasar
    // `/logins-antiguos`, que es otra ruta.
    const LOGIN_LITERAL = /(?<![\w-])\/login\b/;
    expect(LOGIN_LITERAL.test('await page.goto("/login");')).toBe(true);
    expect(LOGIN_LITERAL.test('!url.pathname.startsWith("/login")')).toBe(true);
    expect(LOGIN_LITERAL.test(".not.toMatch(/^\\/login/)")).toBe(true);
    // Y no se dispara con la ruta canónica ni con una palabra que la contenga.
    expect(LOGIN_LITERAL.test('page.goto("/iniciar-sesion")')).toBe(false);
    expect(LOGIN_LITERAL.test('href="/logins-antiguos"')).toBe(false);
  });
});

describe("el predicado en sí", () => {
  it("reconoce las dos rutas como pantalla de ingreso", () => {
    expect(isSignInPath("/iniciar-sesion")).toBe(true);
    expect(isSignInPath("/login")).toBe(true);
    // Con query string el pathname no la incluye; con subruta sí importa.
    expect(isSignInPath("/iniciar-sesion/verificar")).toBe(true);
  });

  it("no confunde una ruta que apenas empieza igual", () => {
    // `startsWith` a secas diría true para `/loginX`. La comparación es por
    // segmento, no por prefijo de texto.
    expect(isSignInPath("/iniciar-sesion-ayuda")).toBe(false);
    expect(isSignInPath("/loginza")).toBe(false);
  });

  it("leftSignIn es falso parado en el login y verdadero adentro", () => {
    expect(leftSignIn(new URL("https://x.test/iniciar-sesion"))).toBe(false);
    expect(leftSignIn(new URL("https://x.test/login"))).toBe(false);
    expect(leftSignIn(new URL("https://x.test/admin"))).toBe(true);
    expect(leftSignIn(new URL("https://x.test/mis-mascotas/DIM-AAAA-BBBB"))).toBe(true);
  });
});

describe("el 308 de la ruta vieja sigue en pie", () => {
  it("app/(auth)/login redirige permanentemente y conserva el query string", () => {
    // La promesa está escrita en el propio archivo ("this stub stays FOREVER")
    // y nada la verificaba. `intent` y `returnTo` son el punto entero de un
    // round-trip de login: perderlos vara justo al visitante que tenía adónde
    // volver.
    const stub = readFileSync(join(process.cwd(), "app/(auth)/login/page.tsx"), "utf8");
    expect(stub).toContain("permanentRedirect");
    expect(stub).toContain(SIGN_IN_PATH);
    expect(stub, "el query string se reenvía").toMatch(/URLSearchParams/);
  });
});
