// Which database is this fence looking at? — shared by the DB-backed lints.
//
// Three fences in `pnpm verify` open a DATABASE_URL connection and judge what
// they find: lint:rls, lint:scope-authz, lint:spine. They all face the same
// two hazards, so they answer them the same way, from here:
//
//   1. A REMOTE host. The cutover runbook leaves a console with the staging
//      pooler in DATABASE_URL (readiness doc §B4). `pnpm verify` in that shell
//      audits staging without saying so — and the worst outcome is not the lost
//      half hour, it is "fixing" the wrong database. A non-local host is
//      therefore a SKIP, not a pass and not a failure, unless the operator
//      typed --allow-remote. These fences are strictly read-only, so auditing a
//      remote database on purpose is allowed — it just has to be on purpose.
//
//   2. An UNREACHABLE database. A DB-less CI box is not a failure; it is a run
//      that proved nothing, and it has to say so.
//
// The rule underneath both: silence is never the answer. Every exit path names
// the database it looked at and states which checks did not run.
//
//   3. A WRITER (WU6/7 review, L-2). `LOCAL_HOSTS` below is the READ-ONLY
//      fences' notion of local and it is deliberately generous (`db`,
//      `0.0.0.0`, `host.docker.internal`, the compose hostname): the worst a
//      fence can do with a wrong guess is audit the wrong database. A writer
//      borrowing it would WRITE through a DATABASE_URL whose host is literally
//      `db` with no flag typed. Writers ask `isLocalWriterTarget` instead: the
//      Supabase CLI stack — loopback on port 54322 — and nothing else; anything
//      beyond that is named with --allow-remote, on purpose.

/** The local Supabase stack, used when DATABASE_URL is unset. */
export const DEFAULT_LOCAL_URL = "postgresql://postgres:postgres@localhost:54322/postgres";

/**
 * Hosts a WRITER treats as its own machine without a flag: loopback only —
 * nothing Docker names, nothing that could be a tunnel. Hazard 3 above.
 */
export const WRITER_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The Supabase CLI's Postgres port (`pnpm db:start`); a writer's "local" is this stack. */
export const SUPABASE_CLI_DB_PORT = "54322";

/** Hostnames that are unambiguously a developer's own machine / Docker stack. */
export const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "host.docker.internal",
  // The hostname the Supabase CLI's own containers use on the compose network.
  "supabase_db_dim",
  "db",
]);

export type DbTarget = {
  /** Human-readable `host:port/database`, never containing credentials. */
  label: string;
  host: string;
  /** As a string, the way `URL.port` hands it back; "5432" when the URL omits it. */
  port: string;
  /** The READ-ONLY fences' verdict (LOCAL_HOSTS). Writers use `isLocalWriterTarget`. */
  isLocal: boolean;
  /**
   * Ref del proyecto Supabase, cuando la URL lo trae.
   *
   * POR QUÉ EL HOST NO ALCANZA (2026-08-13): la cuenta tiene DOS proyectos
   * —producción y staging— y los dos se conectan por el MISMO host de pooler,
   * `aws-1-sa-east-1.pooler.supabase.com`. Así que `label` era literalmente
   * idéntico para los dos, y "Database looked at: …" no respondía la única
   * pregunta que existe para responder: ¿cuál de las dos?
   *
   * El commit 5bee0f27 arregló exactamente esto para los seeds y repair:dni,
   * pero no llegó a este helper — el mismo patrón "el fix no alcanzó al
   * hermano" que este repo viene encontrando. Se notó al migrar staging: hubo
   * que comparar los refs a mano porque ninguna herramienta lo imprimía.
   *
   * El ref viaja en el usuario de la URL del pooler (`postgres.<ref>`), que el
   * strip de credenciales se lleva puesto, y también en `db.<ref>.supabase.co`.
   */
  projectRef: string | null;
  /** Set when the URL could not be parsed at all. */
  parseError: string | null;
};

/** Recupera el ref del proyecto de las tres formas en que Supabase lo expone. */
function extractProjectRef(u: URL): string | null {
  // Pooler: postgres://postgres.<ref>:<pass>@aws-…pooler.supabase.com
  const fromUser = u.username.match(/^postgres\.([a-z0-9]+)$/)?.[1];
  if (fromUser) return fromUser;
  // Conexión directa: db.<ref>.supabase.co  |  <ref>.supabase.co
  const fromHost = u.hostname.match(/^(?:db\.)?([a-z0-9]{20})\.supabase\.co$/)?.[1];
  return fromHost ?? null;
}

/**
 * Describe the target database WITHOUT connecting and WITHOUT ever echoing a
 * password. An unparseable URL is treated as non-local — the safe assumption.
 */
export function describeTarget(rawUrl: string): DbTarget {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    const port = u.port === "" ? "5432" : u.port;
    const database = u.pathname.replace(/^\//, "") || "(default)";
    const projectRef = extractProjectRef(u);
    return {
      // El ref va en el label porque el label es lo que se imprime en TODOS los
      // mensajes de skip y de veredicto. Sin él, dos bases distintas producen
      // exactamente la misma línea.
      label: `${host}:${port}/${database}${projectRef ? `  ref=${projectRef}` : ""}`,
      host,
      port,
      isLocal: LOCAL_HOSTS.has(host),
      projectRef,
      parseError: null,
    };
  } catch (err) {
    return {
      label: "(unparseable DATABASE_URL)",
      host: "(unparseable)",
      port: "(unparseable)",
      isLocal: false,
      projectRef: null,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * A WRITER's "local": the Supabase CLI stack on this machine and nothing else
 * (hazard 3 in the header). Stricter than `isLocal` on purpose — a writer
 * that guesses wrong does not audit the wrong database, it changes it.
 */
export function isLocalWriterTarget(target: DbTarget): boolean {
  return (
    target.parseError === null &&
    WRITER_LOCAL_HOSTS.has(target.host) &&
    target.port === SUPABASE_CLI_DB_PORT
  );
}

/** Join message lines. Keeps every operator-facing message readable in source. */
export const lines = (...parts: string[]): string => parts.join("\n");

/**
 * The reason a non-local target is skipped, phrased for the fence at hand.
 * Returns null when the target is local or the operator opted in — i.e. when
 * the caller should go ahead and connect.
 */
export function remoteSkipReason(target: DbTarget, allowRemote: boolean): string | null {
  if (target.isLocal || allowRemote) return null;
  return target.parseError === null
    ? `DATABASE_URL points at "${target.host}", which is not a local host.`
    : `DATABASE_URL could not be parsed (${target.parseError}).`;
}

/**
 * Print a skip in the shape every fence uses: what was skipped, which database
 * it would have looked at, what did NOT run, and how to get a real run.
 */
export function reportSkip(args: {
  fence: string;
  reason: string;
  target: DbTarget;
  /** Which checks did not run, and which (if any) still did. */
  skipped: string;
  remedy: string;
}): void {
  console.warn(
    lines(
      `[skip] ${args.fence}: ${args.reason}`,
      `  Database looked at: ${args.target.label}`,
      args.skipped,
      args.remedy,
    ),
  );
}

/**
 * The remedy paragraph for a remote-host skip. Identical advice everywhere, so
 * an operator who has read it once recognises it instantly in another fence.
 */
export function remoteRemedy(reads: string): string {
  return lines(
    "  This fence judges the database your migrations run against. Auditing a remote one is a",
    "  deliberate act, not a side effect of a stale shell: re-run with --allow-remote",
    `  (the fence is strictly read-only — it ${reads} and nothing else).`,
    "  To check locally instead: pnpm db:start, then unset DATABASE_URL or point it at",
    `  ${DEFAULT_LOCAL_URL}`,
  );
}
