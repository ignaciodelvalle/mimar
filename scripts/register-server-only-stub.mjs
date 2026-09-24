// Node module-resolution hook for DB-touching scripts launched via tsx.
//
// Why this exists:
//   db/index.ts imports the `server-only` sentinel package (added in b6d0d355 to
//   keep the postgres driver out of client bundles). `server-only` throws unless
//   it is resolved under the `react-server` export condition. Running our scripts
//   under `--conditions=react-server` is NOT a viable fix for scripts that also
//   import server actions: React then resolves to its RSC build (which has no
//   `createContext`) and `next/navigation` fails to load with
//   `_react.default.createContext is not a function`.
//
//   A standalone Node script has no client/server bundle boundary to protect, so
//   we resolve `server-only` / `client-only` to an empty module instead. The Next
//   build is untouched — this hook only applies to a process started with
//   `node --import ./scripts/register-server-only-stub.mjs ...`.
//
// Node 24 note:
//   The previous implementation used `register(dataUrl)`, which installs the hook
//   on a separate worker thread. Under Node 24 + tsx 4.x that worker-thread hook
//   silently breaks tsx's own loader chaining — the entry `.ts` never executes
//   (the process exits 0 with zero output and zero effect, e.g. every `seed:*`
//   became a silent no-op). The synchronous `registerHooks` API runs in-thread
//   and composes correctly with tsx, so the script actually runs. Do NOT revert
//   to `register()`.
import { registerHooks } from "node:module";

const STUBBED = new Set(["server-only", "client-only"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBBED.has(specifier)) {
      return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
