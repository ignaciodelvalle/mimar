// `@dim/contract/tokens` — the Libreta Nacional design tokens, framework-free.
//
// One module today. The subpath exists anyway because a consumer that wants the
// palette should not have to load the event vocabulary or the zod schemas to
// get it, and because `apps/mobile` imports this on its very first render.
export * from "./ln-tokens.ts";
