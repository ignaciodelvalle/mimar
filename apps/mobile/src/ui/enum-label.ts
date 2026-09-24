// The word to show for a value this build has never heard of.
//
// WHY THIS EXISTS (critic gap 3, CANON-451). Every `switch` over a contract enum
// in this app is exhaustive — no `default`, or a `default` that assigns to
// `never` — and that is exactly right at COMPILE time: a value added to the
// contract does not build until somebody writes its sentence. It says nothing
// about RUNTIME, and an OTA channel makes runtime skew ordinary: a published
// bundle can outlive the server it was written against by weeks, because
// `docs/mobile/ota-policy.md` requires the server to stay compatible with the
// oldest install still opening — not the other way round.
//
// What those `default` arms did was `return String(unknown)`. The typechecker
// was satisfied and a citizen read `Provincia: AR-B`-class output: `medication`,
// `org_member`, `open-cases` — an internal identifier, in English, in a wallet
// whose entire UI is es-AR. It is the same defect as printing a raw error code
// (`api/error-copy.ts`'s second door), one layer up.
//
// THE SHAPE IS THE POINT. `value: never` keeps the compile-time exhaustiveness
// exactly as it was — a new enum member still fails to build — while the
// fallback is a real es-AR word rather than the identifier. A `default:` arm
// that simply returned a constant would ALSO be honest at runtime and would
// silently give up the compile-time guarantee, which is the trade nobody wants.
//
// `apps/mobile/src/ui/enum-fallback-fences.test.ts` — a JEST test, run by
// `pnpm --filter mimar exec jest`, beside this file — is what stops the old
// shape growing back. This comment named `__tests__/mobile-enum-fallback-fences.test.ts`
// (root, vitest) until the 2026-09-07 review looked for it: no such file exists,
// and no vitest run has ever covered this rule. A pointer at a fence that is not
// there is worse than no pointer, because it reads as coverage.

/**
 * The es-AR fallback for an enum value this build does not know.
 *
 * @param value the switch subject, narrowed to `never` — the exhaustiveness check
 * @param fallback what a person reads instead of the identifier
 */
export function unknownEnumLabel<T extends string>(value: never, fallback: T): T {
  // `value` is deliberately unused: its only job is to be `never`, which is a
  // question for the compiler and not for the runtime.
  void value;
  return fallback;
}
