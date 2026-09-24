// Type declaration for strip-comments.mjs — a plain JS module (allowJs is off
// project-wide) imported from three TypeScript lint scripts
// (check-copy-contract.ts, check-event-payload-parity.ts,
// check-scope-discipline.ts). Without this companion .d.mts, `tsc --noEmit`
// reports TS7016 (implicit any) on the import under `strict`.
export function stripComments(src: string): string;
