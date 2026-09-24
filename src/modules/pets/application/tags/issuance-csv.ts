// Issuance CSV builder — client-safe (no DB imports): the admin form builds
// and downloads the CSV in the browser from the action response.
//
// `serial,activation_code,url` is the ONE artifact that ever carries the
// plaintext activation codes; it exists in-memory for immediate download and
// is never persisted or logged. Values come from the token generator's
// 31-char alphabet (no commas/quotes), so no CSV escaping is needed.

import type { IssuedTagRow } from "./types";

export function buildTagIssuanceCsv(rows: IssuedTagRow[], baseUrl: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const lines = ["serial,activation_code,url"];
  for (const row of rows) {
    lines.push(`${row.serial},${row.activationCode},${trimmedBase}/t/${row.serial}`);
  }
  return `${lines.join("\n")}\n`;
}
