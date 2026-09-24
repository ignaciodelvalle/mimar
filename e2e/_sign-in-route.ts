// _sign-in-route — dónde vive la pantalla de ingreso, en UN solo lugar.
//
// POR QUÉ EXISTE. El 2026-08-08 las rutas de auth se mudaron al castellano
// (`/login` → `/iniciar-sesion`, QA S1-F06) y `app/(auth)/login/page.tsx` quedó
// como 308 permanente. La suite e2e no se enteró, y el modo en que falló es
// mucho peor que "un test roto":
//
//   const leftLogin = (url) => !url.pathname.startsWith("/login");
//
// Después del 308 el navegador está en `/iniciar-sesion`, que NO empieza con
// `/login`. Ese predicado pasa a ser verdadero en el instante en que aterriza
// la redirección — antes de que se tipee una credencial. `waitForURL(leftLogin)`
// resolvía de inmediato, `loginAs` daba el ingreso por exitoso, y cacheaba las
// cookies ANÓNIMAS para todo el worker. De ahí las 45 fallas de un solo run,
// todas con la misma forma: "expected /admin, but the browser is on
// /iniciar-sesion".
//
// No fue un test que se puso rojo: fue un test que se puso VERDE por el motivo
// equivocado y arrastró a los demás. Seis archivos tenían su propia copia del
// predicado, así que la mudanza los rompió a los seis a la vez — "el gemelo se
// escapa" otra vez, con seis gemelos.
//
// La regla de acá en adelante: nadie escribe la ruta de ingreso a mano. La
// próxima mudanza toca este archivo y nada más.

/** La ruta canónica de ingreso (es-AR). */
export const SIGN_IN_PATH = "/iniciar-sesion";

/**
 * La ruta vieja en inglés. Sigue viva a propósito y para siempre: está impresa
 * en documentos, guardada en favoritos y pegada en mails ya enviados. Devuelve
 * un 308 a SIGN_IN_PATH conservando el query string.
 */
export const LEGACY_SIGN_IN_PATH = "/login";

/**
 * ¿Este pathname ES la pantalla de ingreso? Cubre las dos rutas, porque durante
 * un instante del 308 el navegador está en la vieja y el resto del tiempo en la
 * nueva, y un test que sólo conozca una de las dos vuelve a poder mentir.
 */
export function isSignInPath(pathname: string): boolean {
  return [SIGN_IN_PATH, LEGACY_SIGN_IN_PATH].some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Predicado para `page.waitForURL`: verdadero cuando el navegador YA NO está en
 * la pantalla de ingreso. Este es el que reemplaza a las seis copias de
 * `!url.pathname.startsWith("/login")`.
 */
export const leftSignIn = (url: URL): boolean => !isSignInPath(url.pathname);
