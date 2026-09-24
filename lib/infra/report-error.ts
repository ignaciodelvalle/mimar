// Server-side error reporting — ONE structured JSON line per error.
//
// Free-tier constraint: no external telemetry sink (no Sentry, no paid plans).
// The sink IS stdout/stderr: Vercel captures every console line emitted by a
// function invocation into its queryable function logs. Emitting a single
// JSON.stringify'd line (instead of console.error("label", object), which
// Vercel renders as a multi-line inspect dump) makes the logs filterable by
// `level`, `context`, and `message` in the Vercel log search.
//
// Scope: SERVER catch blocks (route handlers, server components, server
// actions) on the public surface and beyond. The CLIENT error-boundary seam is
// a separate module — lib/observability/report-error.ts — which reports from
// app/error.tsx / global-error.tsx in the browser console; do not merge them:
// this one assumes a Node process whose stdout is captured by the platform.
//
// Usage:
//   try { ... } catch (err) {
//     reportError("public-credential/owner-email", err, { publicToken });
//   }

/** Max stack lines kept (message line + frames). Vercel truncates long log
 * lines; the first frames carry the signal, the rest is noise. */
const MAX_STACK_LINES = 7;

export type ReportErrorMeta = Record<string, unknown>;

type StructuredErrorLine = {
  level: "error";
  context: string;
  message: string;
  name?: string;
  stack?: string;
  meta?: ReportErrorMeta;
  ts: string;
};

function trimStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split("\n");
  return lines.length <= MAX_STACK_LINES ? stack : lines.slice(0, MAX_STACK_LINES).join("\n");
}

/**
 * Report a caught server-side error as one structured JSON line.
 *
 * @param context stable dot/slash-scoped identifier of WHERE the error was
 *                caught, e.g. "public-credential/pet-row" — the primary
 *                filter key in Vercel log search.
 * @param err     the caught value (Error or anything thrown).
 * @param meta    optional structured context (tokens, ids — never PII).
 */
export function reportError(context: string, err: unknown, meta?: ReportErrorMeta): void {
  const error = err instanceof Error ? err : undefined;
  const payload: StructuredErrorLine = {
    level: "error",
    context,
    message: error ? error.message : String(err),
    ...(error?.name && error.name !== "Error" ? { name: error.name } : {}),
    ...(trimStack(error?.stack) ? { stack: trimStack(error?.stack) } : {}),
    ...(meta ? { meta } : {}),
    ts: new Date().toISOString(),
  };

  let line: string;
  try {
    line = JSON.stringify(payload);
  } catch {
    // Circular / unserializable meta — never let the reporter itself throw.
    line = JSON.stringify({ ...payload, meta: "[unserializable]" });
  }
  console.error(line);
}
