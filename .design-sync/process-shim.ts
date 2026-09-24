// Evaluates before every other module in the synth-entry graph (first import
// of entry.ts). next/image's module scope reads process.env.* — previews are
// plain browser IIFEs with no `process`.
(globalThis as { process?: unknown }).process ??= { env: {} };
export {};
