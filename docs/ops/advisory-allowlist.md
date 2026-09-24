# Dependency advisory allowlist

Triage record for `pnpm audit --audit-level=high` findings that are accepted
temporarily, per the contract in `.github/workflows/ci.yml` (dep-audit job).
Each entry needs: advisory, package, why it does not apply, and a patch
deadline. Remove entries as soon as the upstream fix is adopted.

| Advisory | Package | Severity | Accepted because | Deadline |
|---|---|---|---|---|
| [GHSA-gv7w-rqvm-qjhr](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr) | esbuild (transitive: tsx, drizzle-kit, vitest toolchain) | high | The flaw is missing binary integrity verification **when esbuild is installed under Deno**. This project never installs or runs esbuild via Deno — it is a dev-only transitive dependency under pnpm/Node, not part of the runtime bundle. No production exposure. | Re-check on next toolchain bump (tsx / drizzle-kit / vitest), or 2026-07-15, whichever comes first. |
