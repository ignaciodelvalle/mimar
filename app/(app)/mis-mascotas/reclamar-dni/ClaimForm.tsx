// SECURITY GATE (review 2026-05-19 §2.1): the DNI-only claim flow is paused
// until Mi Argentina identity verification lands. Server action returns an
// error if invoked directly; this component renders the explanation instead
// of an input form so users understand what to do in the meantime.

export function ClaimForm() {
  return (
    <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] p-4">
      <p className="text-sm font-medium text-[var(--color-ln-warn)]">
        Reclamo por DNI temporalmente pausado
      </p>
      <p className="text-sm text-[var(--color-ln-warn)]">
        Estamos integrando la verificación de identidad con Mi Argentina para que reclamar tu
        adopción sea seguro. Mientras tanto, si tu refugio te avisó que registró tu adopción a tu
        DNI, escribinos a soporte y te ayudamos a vincular el perfil manualmente.
      </p>
    </div>
  );
}
