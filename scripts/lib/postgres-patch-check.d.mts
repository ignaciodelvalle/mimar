// Type declaration for postgres-patch-check.mjs, a plain JS module (allowJs is
// off project-wide) that scripts/build.mjs runs and a test imports.
export const POSTGRES_PATCH_MARKER: string;
export const PATCHED_FILES: string[];
export function unpatchedPostgresFiles(repoRoot: string): string[];
export function unpatchedPostgresMessage(missing: string[]): string;
export const UPSTREAM_EXECUTE_SHAPE: RegExp;
export const TRACED_CONNECTION: RegExp;
export function builtPostgresProblems(nextDir: string): {
  problems: string[];
  bundled: number;
  traced: number;
};
export function builtPostgresMessage(problems: string[]): string;
