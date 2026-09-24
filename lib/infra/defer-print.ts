/**
 * deferPrint — schedules `print` via setTimeout(fn, 0) so the click handler
 * returns immediately before the browser opens the print dialog.
 *
 * WHY: window.print() is synchronous and blocks the main thread while the
 * browser prepares and shows the print dialog. When called directly inside a
 * click handler, that synchronous block is attributed to the interaction,
 * triggering an INP (Interaction to Next Paint) warning. Wrapping the call in
 * setTimeout(fn, 0) lets the handler return fast — the interaction completes
 * before the expensive work starts — which is the standard INP mitigation for
 * print triggers.
 *
 * Framework-free: no React or Next.js imports so this can be tested in a plain
 * Node/Vitest environment without jsdom.
 */
export function deferPrint(print: () => void = () => window.print()): void {
  setTimeout(print, 0);
}
