// "Salir" for a session that has no account behind it. Matters more here than on
// an authenticated route: the reporter may well be on a borrowed device, and the
// only thing standing between the next person and their denuncia is a cookie.
//
// A NATIVE form POST to a route handler, not a server action — see
// ./salir/route.ts for why (a Server Action's redirect() is dropped by the client
// router, so the cookie would clear while the page kept showing the denuncia).
// Consequence: no "use client", no JS required, and the button cannot be fired by
// a prefetch.

export function SalirDelSeguimiento() {
  return (
    <form action="/denuncias/seguimiento/salir" method="post" data-print-hide>
      <button
        type="submit"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-ln-mute)] underline underline-offset-2 hover:text-[var(--color-ln-ink-2)] transition-colors print:hidden"
      >
        Salir
      </button>
    </form>
  );
}
