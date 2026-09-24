// isLocalUrl (scripts/_env-target.ts) decides whether a seed that writes a
// fixed, published password may run. "Local" is the permissive answer, so the
// check must compare the parsed hostname, never search the string.

import { describe, expect, it } from "vitest";

import { isLocalUrl } from "@/scripts/_env-target";

describe("isLocalUrl", () => {
  it.each([
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "http://LOCALHOST:3000/",
    "http://[::1]:54321",
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "postgresql://postgres:postgres@localhost:54322/postgres",
  ])("accepts the local machine: %s", (url) => {
    expect(isLocalUrl(url)).toBe(true);
  });

  it.each([
    // The hostname merely STARTS with "localhost" — a real remote project.
    "https://localhost.example.supabase.co",
    // "127.0.0.1" as a subdomain label of a remote host.
    "https://127.0.0.1.attacker.example",
    // The local names appear only in the path, query or password.
    "https://abcdefghijklmnopqrst.supabase.co/localhost",
    "https://abcdefghijklmnopqrst.supabase.co/?next=http://127.0.0.1",
    "postgresql://postgres:localhost@aws-1-sa-east-1.pooler.supabase.com:6543/postgres",
    // Not a URL at all: fail closed.
    "localhost",
    "",
  ])("refuses anything that is not the local machine: %s", (url) => {
    expect(isLocalUrl(url)).toBe(false);
  });
});
