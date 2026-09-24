import { LnButton } from "@/components/ui/Button";

/**
 * What the owner portal says when it cannot establish WHO is asking.
 *
 * WHY THIS EXISTS SEPARATELY from `AnalyticsLoadFallback`. That one is drawn in
 * place of a dashboard BODY when its figures fail to load: the page around it is
 * intact, the person is an operator at a desk, and the copy is about data. This
 * is drawn in place of the ENTIRE PORTAL when the auth round-trip or the profile
 * read misses its deadline, to a citizen who may be standing in the street. It
 * is also a different design tier — that component is built from `Op*`
 * primitives, which have no business on a citizen surface.
 *
 * WHY NOT RENDER `children` ANYWAY. Because the layout would be rendering
 * somebody's private portal without knowing whose it is. Every page underneath
 * has its own guard, so it would most likely fail again one level down — but
 * "most likely" is not the standard for showing a person's animals, address and
 * phone number, and a second failure a layer deeper reads as a broken app rather
 * than as a refusal.
 *
 * WHY IT NAMES A CODE. The same correlation id is in the server log beside the
 * real error, so somebody quoting it in a message can be found in one grep. It
 * is rendered quietly: it matters to us and means nothing to them.
 *
 * NO NAVIGATION CHROME, deliberately. The tab bar's contents come from the reads
 * that just failed, and a nav drawn from a zero-state would offer links that
 * cannot work. A single honest action beats a shell full of dead ends.
 */
export function AppSessionUnavailable({
  reason,
  correlationId,
}: {
  reason: "timeout" | "error";
  correlationId?: string;
}) {
  const title =
    reason === "timeout" ? "Esto está tardando más de lo normal" : "No pudimos abrir tu cuenta";
  const description =
    reason === "timeout"
      ? "No llegamos a verificar tu sesión. Suele ser momentáneo: probá de nuevo en unos segundos."
      : "Hubo un problema al verificar tu sesión. Probá de nuevo.";

  return (
    <main className="mx-auto flex min-h-screen max-w-[460px] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="m-0 font-ln-serif text-2xl font-semibold leading-tight text-[var(--color-ln-ink)]">
        {title}
      </h1>
      <p className="m-0 text-md leading-relaxed text-[var(--color-ln-mute)]">{description}</p>
      {/* A full-document GET, not a client transition: whatever is degraded is
          server-side, and a soft navigation would re-run the same failed render
          without giving the server a fresh request. */}
      <LnButton href="/inicio" variant="primary" size="md">
        Reintentar
      </LnButton>
      {/* THE CREDENTIAL STILL WORKS WITHOUT A SESSION. If somebody is here
          because they are trying to show their animal's papers, the public page
          is served by a different path and does not need any of what just
          failed. Saying so costs a line and saves the moment. */}
      <p className="m-0 text-sm text-[var(--color-ln-faint)]">
        La credencial pública de tus mascotas sigue funcionando: se abre con el código de la chapita
        y no necesita que inicies sesión.
      </p>
      {correlationId ? (
        <p className="m-0 font-ln-mono text-xs text-[var(--color-ln-faint)]">
          Código: {correlationId}
        </p>
      ) : null}
    </main>
  );
}
