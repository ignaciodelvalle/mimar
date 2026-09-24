/**
 * Resolución del entorno destino para los scripts que escriben datos.
 *
 * EL AGUJERO QUE ESTO TAPA
 * ------------------------
 * Cada seed traía su propio guard, y todos protegían de UNA sola cosa: apuntar a
 * un remoto sin `--allow-remote`. Ninguno protegía del caso inverso ni del peor
 * de los tres — el entorno PARTIDO.
 *
 * 2026-08-11: `.env.staging.local` tiene el DATABASE_URL de staging pero no las
 * variables de Supabase Auth. Al cargarlo, dotenv completó las que faltaban
 * desde `.env.local`, o sea locales. El seed entonces escribía con Drizzle en
 * STAGING mientras el SDK de Auth leía de la base LOCAL, y avisó exactamente al
 * revés: "seeding into a REMOTE project (http://127.0.0.1:54321)" — la palabra
 * REMOTO con una URL local. Murió con "Perfil no encontrado" recién en el paso
 * 3, después de haber intentado escrituras contra el entorno equivocado.
 *
 * `isLocal = local(SUPABASE_URL) && local(DATABASE_URL)` colapsa tres estados en
 * dos: con una sola URL remota ya se considera "remoto" y sigue. Acá los tres
 * estados son explícitos y el mixto NO se puede saltear — ni con --allow-remote,
 * porque no hay ninguna razón legítima para escribir la mitad de una operación
 * en cada base.
 */

export type EnvTarget = {
  /** Ambas URLs apuntan a la máquina local. */
  isLocal: boolean;
  /** Host de la base, sin credenciales — para imprimirlo sin filtrar secretos. */
  dbHost: string;
  /** Host del proyecto Supabase. */
  supabaseHost: string;
};

/** Hostnames that mean "this machine". Compared EXACTLY, never as substrings. */
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Does this URL point at the local machine?
 *
 * PARSED, NOT SUBSTRING-MATCHED. The previous check was
 * `u.includes("127.0.0.1") || u.includes("localhost")`, which answered yes for
 * `https://localhost.example.supabase.co` and for any remote URL carrying
 * "localhost" in its path, query or password — and "local" is the answer that
 * lets a seed with a published password write. The hostname is compared as a
 * whole; a string that does not parse as a URL is NOT local (fail closed).
 */
export function isLocalUrl(u: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(u).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOCAL_HOSTNAMES.has(hostname);
}

/**
 * Host + REF DEL PROYECTO, sin credenciales.
 *
 * El ref no es decoración: esta cuenta tiene dos proyectos Supabase —
 * `DIM` (producción) y `DIM-staging`— y AMBOS se conectan por el mismo host de
 * pooler, `aws-1-sa-east-1.pooler.supabase.com`. Imprimir sólo el host produce
 * una línea idéntica antes de escribir en staging o en producción, que es
 * exactamente la pregunta que este mensaje existe para responder.
 *
 * El ref viaja en el USUARIO de la URL del pooler (`postgres.<ref>@…`), que el
 * strip de credenciales se llevaba puesto, o en el host de conexión directa
 * (`db.<ref>.supabase.co`) y en la URL de la API (`<ref>.supabase.co`).
 */
export function describeTarget(url: string): string {
  const noScheme = url.replace(/^[a-z+]+:\/\//i, "");
  const userInfo = noScheme.includes("@") ? noScheme.slice(0, noScheme.lastIndexOf("@")) : "";
  const host = noScheme.replace(/.*@/, "").replace(/[/?].*/, "");

  const ref =
    // pooler: postgres.<ref>
    userInfo.match(/^[^:]*\.([a-z0-9]{20})/i)?.[1] ??
    // conexión directa: db.<ref>.supabase.co · API: <ref>.supabase.co
    host.match(/(?:^|\.)([a-z0-9]{20})\.supabase\.(?:co|com)/i)?.[1] ??
    null;

  return ref ? `${host} (proyecto ${ref})` : host;
}

/**
 * Aborta si Supabase Auth y la base apuntan a entornos DISTINTOS.
 *
 * Se exporta aparte porque la mayoría de los seeds ya traen su propio bloque de
 * aborto para el caso remoto, con mensajes que explican bien el riesgo de cada
 * uno. Lo único que a todos les faltaba era ESTE caso, así que agregan una línea
 * en vez de reescribir un aborto que ya estaba bien.
 *
 * No recibe `allowRemote` a propósito: no hay flag que habilite escribir la
 * mitad de una operación en cada base.
 */
export function assertNotSplitEnv(supabaseUrl: string, databaseUrl: string, label: string): void {
  // Una URL vacía no se puede clasificar, y no es este el lugar donde reportarlo:
  // cada script ya valida sus variables obligatorias con su propio mensaje. Sin
  // esta salida, "" se leería como REMOTO y el guard acusaría un entorno partido
  // donde lo que falta es una variable.
  if (!supabaseUrl || !databaseUrl) return;

  const supabaseLocal = isLocalUrl(supabaseUrl);
  const databaseLocal = isLocalUrl(databaseUrl);
  if (supabaseLocal === databaseLocal) return;

  console.error(
    [
      `\n[${label}] ENTORNO PARTIDO — me niego a escribir.`,
      "",
      `  Supabase Auth  → ${describeTarget(supabaseUrl)}  (${supabaseLocal ? "LOCAL" : "REMOTO"})`,
      `  Base de datos  → ${describeTarget(databaseUrl)}  (${databaseLocal ? "LOCAL" : "REMOTO"})`,
      "",
      "  Las dos tienen que apuntar al MISMO entorno. Escribir con una en cada",
      "  lado deja usuarios en una base y perfiles en la otra.",
      "",
      "  Causa habitual: cargaste .env.staging.local, que trae DATABASE_URL pero",
      "  no NEXT_PUBLIC_SUPABASE_URL ni SUPABASE_SERVICE_ROLE_KEY — y dotenv",
      "  completó las que faltaban desde .env.local.",
      "",
      "  Usá scripts/use-staging.ps1 (o .sh), que cargan las tres y verifican antes.\n",
    ].join("\n"),
  );
  process.exit(2);
}

/**
 * ¿Las DOS URLs apuntan a esta máquina? Una URL vacía NO es local: sin
 * DATABASE_URL no hay forma de saber dónde se escribe, y "local" es la
 * respuesta que habilita la contraseña publicada. Reemplaza el viejo
 * `dbHost ? LOCAL_HOSTS.has(dbHost) : true` + `includes("localhost")` que
 * copiaban tres seeds (F7 de la revisión de R8/C4b, 2026-09-23).
 */
export function isLocalTarget(supabaseUrl: string, databaseUrl: string): boolean {
  if (!supabaseUrl || !databaseUrl) return false;
  return isLocalUrl(supabaseUrl) && isLocalUrl(databaseUrl);
}

/**
 * Qué tiene de malo un candidato a SEED_DEMO_PASSWORD, o null si sirve.
 * Pura, para que los tests la fijen sin pasar por process.exit.
 */
export function seedPasswordProblem(
  candidate: string | undefined,
  localLiteral = "Test1234!",
): string | null {
  if (candidate === undefined || candidate === "") return "falta SEED_DEMO_PASSWORD en el entorno";
  if (candidate.trim() === "") return "SEED_DEMO_PASSWORD está en blanco (sólo espacios)";
  if (candidate === localLiteral) {
    return "SEED_DEMO_PASSWORD es el mismo literal publicado en el repo público";
  }
  return null;
}

/**
 * Resuelve la contraseña compartida que un seed usa para las cuentas de
 * prueba. Local mantiene el literal publicado (de eso depende la suite de
 * tests y el dev local); contra CUALQUIER destino no-local ese mismo literal
 * ya está publicado en el repo público, así que exige `SEED_DEMO_PASSWORD`
 * por env y aborta si falta, si está en blanco o si ES el literal — nunca
 * escribe el literal conocido en una base remota (R8, 2026-09-23).
 *
 * En remoto esta contraseña sólo se usa para cuentas que el seed CREA: las
 * que ya existen conservan la suya (ver shouldResetSeedPassword).
 */
export function resolveSeedPassword(
  isLocal: boolean,
  label: string,
  localLiteral = "Test1234!",
): string {
  if (isLocal) return localLiteral;
  const fromEnv = process.env.SEED_DEMO_PASSWORD;
  const problem = seedPasswordProblem(fromEnv, localLiteral);
  if (problem !== null || fromEnv === undefined) {
    console.error(
      [
        `[${label}] Me niego: el destino no es local y ${problem ?? "falta SEED_DEMO_PASSWORD"}.`,
        "  El literal local está publicado en el repo público (scripts/seed-test-users.ts) —",
        "  usarlo contra un entorno remoto escribiría una contraseña que cualquiera puede leer.",
        "  Seteá SEED_DEMO_PASSWORD (una contraseña propia, sólo para las cuentas que este",
        "  seed cree) y volvé a correr.",
      ].join("\n"),
    );
    process.exit(2);
  }
  return fromEnv;
}

/**
 * ¿Debe un seed (re)escribir la contraseña de una cuenta con updateUserById?
 *
 * - Recién creada: no hace falta — createUser ya la dejó puesta.
 * - Ya existía, destino LOCAL: sí, como siempre (re-converge al literal).
 * - Ya existía, destino REMOTO: NUNCA. Decisión del orquestador tras la
 *   revisión de seguridad de R8/C4b (2026-09-23): un re-seed de staging no
 *   puede pisar en silencio la contraseña rotada de las 8 cuentas e2e
 *   (scripts/ops/rotate-staging-e2e-password.ts) ni la de ninguna cuenta real.
 *   Cambiar una contraseña remota es un acto deliberado, no un efecto lateral.
 */
export function shouldResetSeedPassword(isLocal: boolean, created: boolean): boolean {
  if (created) return false;
  return isLocal;
}

/**
 * Cómo imprime un seed la contraseña compartida. Local: el literal (es
 * público y es lo que el dev necesita ver). Remoto: nunca el valor — un log
 * de terminal o de CI no es lugar para una contraseña real.
 */
export function seedPasswordForDisplay(isLocal: boolean, password: string): string {
  return isLocal
    ? password
    : "(from SEED_DEMO_PASSWORD — only on accounts this run created; existing accounts keep theirs)";
}

/**
 * Clasifica el destino y aborta el proceso si no es seguro escribir.
 *
 * @param supabaseUrl NEXT_PUBLIC_SUPABASE_URL — lo que usa el SDK de Auth.
 * @param databaseUrl DATABASE_URL — lo que usa Drizzle.
 * @param allowRemote El script recibió --allow-remote.
 * @param label Nombre del script, para los mensajes.
 */
export function resolveEnvTarget(
  supabaseUrl: string,
  databaseUrl: string,
  allowRemote: boolean,
  label: string,
): EnvTarget {
  const supabaseLocal = isLocalUrl(supabaseUrl);
  const databaseLocal = isLocalUrl(databaseUrl);
  const supabaseHost = describeTarget(supabaseUrl);
  const dbHost = describeTarget(databaseUrl);

  assertNotSplitEnv(supabaseUrl, databaseUrl, label);

  const isLocal = supabaseLocal && databaseLocal;

  if (!isLocal && !allowRemote) {
    console.error(
      `[${label}] Me niego: el destino es REMOTO (${supabaseHost} / ${dbHost}). Re-corré con --allow-remote si es a propósito.`,
    );
    process.exit(2);
  }
  if (!isLocal) {
    console.warn(
      `\n[${label}] ATENCIÓN: --allow-remote en efecto — escribiendo en un entorno REMOTO.\n  Supabase → ${supabaseHost}\n  Base     → ${dbHost}\n`,
    );
  } else {
    console.log(`[${label}] destino LOCAL → ${dbHost}`);
  }

  return { isLocal, dbHost, supabaseHost };
}
