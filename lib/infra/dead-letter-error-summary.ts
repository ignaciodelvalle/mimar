// What `notification_dead_letter.error_message` is allowed to say about the
// failure that put a row there.
//
// The column used to hold `err.message` verbatim. drizzle-orm wraps every
// failed query in a DrizzleQueryError whose message is
// `Failed query: <sql>\nparams: <params>` — and the params of a notification
// insert ARE the notification: recipient id, title, body and CTA, which for a
// found-pet or sighting report carry a finder's name and phone. The bulk path
// wrote that message, with every recipient of the chunk in it, into each row of
// a failed chunk. The erasure RPC (0226) redacted `payload` and left this
// column alone on the belief that it was harmless; migration 0228 corrects
// that and scrubs the rows already written.
//
// What survives here is what triage needs and nothing a person wrote:
//   · the Postgres SQLSTATE (`code`) and the constraint / table / column names
//     the server reports — identifiers of the schema, never of a row;
//   · for an error that carries no code, its name and the first line of its
//     message, unless that line is itself a query wrapper.
// Never `params`, never the query text, never the server's `detail` (a unique
// violation's detail reads `Key (dedupe_key)=(<value>)`), never `where`.

/** The longest error_message a dead-letter row keeps. */
const MAX_SUMMARY_LENGTH = 200;

/** Error fields that name schema objects. Both driver spellings are accepted. */
const IDENTIFIER_FIELDS: ReadonlyArray<readonly [label: string, keys: readonly string[]]> = [
  ["constraint", ["constraint_name", "constraint"]],
  ["table", ["table_name", "table"]],
  ["column", ["column_name", "column"]],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A message that is (or wraps) a query dump — never safe to keep. */
function isQueryDump(message: string): boolean {
  return message.includes("Failed query") || message.includes("params:");
}

/** The innermost error carrying a string `code`, walking `.cause` a few levels. */
function findCodedError(err: unknown): Record<string, unknown> | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && isRecord(current); depth += 1) {
    if (typeof current.code === "string" && current.code.length > 0) return current;
    current = current.cause;
  }
  return null;
}

function errorName(value: Record<string, unknown>): string {
  return typeof value.name === "string" && value.name.length > 0 ? value.name : "Error";
}

/**
 * Summarise a notification insert failure for `notification_dead_letter.error_message`
 * without the query parameters or any other row data. Pure.
 */
export function summarizeDeadLetterError(err: unknown): string {
  const coded = findCodedError(err);
  if (coded) {
    const parts = [`code=${String(coded.code)}`];
    for (const [label, keys] of IDENTIFIER_FIELDS) {
      const key = keys.find((k) => typeof coded[k] === "string" && coded[k] !== "");
      if (key) parts.push(`${label}=${String(coded[key])}`);
    }
    return `${errorName(coded)}: ${parts.join(" ")}`.slice(0, MAX_SUMMARY_LENGTH);
  }

  if (!isRecord(err)) return `non-error thrown (${typeof err})`;

  const name = errorName(err);
  const firstLine = typeof err.message === "string" ? (err.message.split("\n")[0] ?? "") : "";
  if (firstLine === "" || isQueryDump(firstLine)) {
    // A wrapper with no coded cause: say what it was, not what it carried.
    return name;
  }
  return `${name}: ${firstLine}`.slice(0, MAX_SUMMARY_LENGTH);
}
