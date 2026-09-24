// outbound-channels — which ways OUT of the system are actually wired, and what
// breaks for a real person when one is not.
//
// WHY THIS EXISTS
// `lib/infra/env.ts` deliberately does NOT validate feature-scoped secrets at
// boot (see its header): forcing RESEND_API_KEY at startup would break every
// environment that has not turned mail on yet. That decision is right, and it
// leaves a hole this module fills — nothing anywhere reported whether the mail
// channel was live, so the only way to find out was for a citizen to press
// "Enviarme el enlace" and never receive it.
//
// That specific silence matters more than it looks. Since the denuncia code
// page stopped rendering report content (PO decision, 2026-08-17), the emailed
// access link is the ONLY route a reporter without an account has to their own
// denuncia. `solicitarAccesoDenunciaAction` returns the same neutral message on
// every branch — on purpose, so the endpoint cannot be used as an existence
// oracle — which means an unconfigured mailer and a successful send are
// INDISTINGUISHABLE to the person waiting. The anti-oracle property is correct
// and must not be weakened; the readiness signal therefore has to surface
// somewhere else, to an operator, ahead of time. That somewhere is
// /admin/sistema.
//
// WHAT THIS DOES NOT CLAIM
// Presence of a key is not proof of delivery. A configured Resend account can
// still reject every message — unverified sending domain, suspended account,
// bounced address. So `configured` means exactly "the app can attempt a send",
// never "mail arrives", and the copy on the card says so. Overclaiming here
// would rebuild, one layer up, the same false comfort this module was written
// to remove.

/** A way the system can reach a person who is not looking at a screen. */
export type OutboundChannelKey = "email" | "sms" | "webPush";

export type OutboundChannelStatus =
  /** The app can attempt a send. Says nothing about whether it arrives. */
  | "configured"
  /**
   * Wired and keyed, but able to reach only the provider account's own
   * mailbox — not the public. Added 2026-08-18 (see RESEND_FROM below): with
   * no verified sending domain the only usable sender is the provider's shared
   * test address, and Resend refuses every recipient except the account owner.
   *
   * It is its OWN state on purpose. Folding it into "configured" would put a
   * green pill on a channel that cannot reach a single citizen, which is the
   * exact class of false comfort this module exists to remove; folding it into
   * "unconfigured" would hide that the mechanism does work and is testable.
   */
  | "restricted"
  /** Wiring exists but this environment has not been given its secrets. */
  | "unconfigured"
  /** No implementation exists at all — not a deployment gap, a product gap. */
  | "not-built";

export type OutboundChannel = {
  key: OutboundChannelKey;
  /** es-AR label for the operator screen. */
  label: string;
  status: OutboundChannelStatus;
  /**
   * Env var names this channel needs. NAMES ONLY — a value never leaves the
   * server and never reaches this object, so the card can be rendered without
   * putting a secret one React tree away from the browser.
   */
  requires: readonly string[];
  /**
   * What a real person loses while this channel is down, in concrete terms.
   * Written as a consequence, not a feature list: an operator reading this
   * screen needs to know who is stranded, not which module is off.
   */
  consequence: string;
};

/** Read-only view of the env; injectable so tests never mutate process.env. */
export type EnvLike = Record<string, string | undefined>;

function present(env: EnvLike, name: string): boolean {
  return (env[name] ?? "").trim().length > 0;
}

/**
 * Provider-owned shared sender. Works with no DNS at all, and Resend will only
 * deliver from it to the account owner's own verified address.
 */
export const FALLBACK_MAIL_SENDER = "miMAR <onboarding@resend.dev>";

/**
 * The From: address every outbound mail uses.
 *
 * WHY THIS IS AN ENV VAR AND NOT A CONSTANT (2026-08-18).
 * It used to be hardcoded, twice, as `miMAR <noreply@dim.ar>` — and `dim.ar`
 * does not exist. So the address was unusable on two counts. First the
 * practical one: a provider will not send from a domain nobody has verified,
 * so every send would have been refused no matter what key was set. Second the
 * one this project already has a rule for: DIM is the INTERNAL codename and
 * miMAR is the public brand (there is a lint fence for exactly this), so mail
 * signed by the codename domain was off-brand even in the hypothetical where
 * the domain existed.
 *
 * This paragraph used to close by naming `mimar.ar` as "the canonical public
 * domain the rest of the code uses", which was doubly wrong by 2026-09-07: it
 * does not exist either (no NS, no MX on 8.8.8.8 or 1.1.1.1), so the sentence
 * held up one dead domain as the cure for another. The domain the project owns
 * is CANONICAL_DOMAIN in lib/infra/site-url.ts, `mimar.com.ar`, verified at
 * Resend since 2026-08-28 — which is what makes it a usable RESEND_FROM and
 * not just a better-looking string.
 *
 * Making it configuration means the day a domain is registered and verified,
 * the switch is one env var — no code change, no redeploy of a constant.
 */
export function resolveMailSender(env: EnvLike): string {
  const configured = (env.RESEND_FROM ?? "").trim();
  return configured.length > 0 ? configured : FALLBACK_MAIL_SENDER;
}

/**
 * True when the sender is the provider's shared test address, which can only
 * reach the account owner. Keyed on the provider domain rather than on string
 * equality so a variant of the same shared sender is still recognised.
 */
export function senderIsProviderFallback(sender: string): boolean {
  return /@resend\.dev\b/i.test(sender);
}

/**
 * Derives channel readiness from environment presence. Pure: takes the env as
 * an argument rather than reading the global, so the whole table is testable
 * without touching process.env.
 */
export function deriveOutboundChannels(env: EnvLike): OutboundChannel[] {
  const emailKeys = ["RESEND_API_KEY"] as const;
  const pushKeys = ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;

  // Un solo lugar donde se decide el estado del correo, para que el texto de
  // abajo no pueda contradecir a la pastilla.
  const emailStatus: OutboundChannelStatus = !emailKeys.every((k) => present(env, k))
    ? "unconfigured"
    : senderIsProviderFallback(resolveMailSender(env))
      ? "restricted"
      : "configured";

  return [
    {
      key: "email",
      label: "Correo electrónico",
      // Tres estados, no dos: tener la clave no basta si el remitente es el
      // compartido del proveedor, porque entonces el único destinatario posible
      // es la casilla de la propia cuenta.
      status: emailStatus,
      requires: emailKeys,
      // LA CONSECUENCIA SE DERIVA DEL ESTADO, no de una condición paralela.
      //
      // Estuvo un rato eligiendo su texto mirando SOLO el remitente, y como sin
      // RESEND_FROM el remitente es el compartido haya clave o no, la tarjeta
      // llegó a mostrar la pastilla "SIN CONFIGURAR" con el párrafo del estado
      // restringido debajo: decía que no está configurado y a la vez explicaba
      // cómo está enviando. Encontrado mirando la pantalla en staging, no por
      // los tests — la aserción que debía cubrirlo pedía que el texto
      // contuviera "denunci", y AMBOS textos lo contienen.
      consequence:
        emailStatus === "restricted"
          ? "Se envía desde el remitente compartido del proveedor, que solo entrega a la casilla de la cuenta. Sirve para comprobar que el mecanismo anda; a un denunciante cualquiera no le llega. Para que salga de verdad hace falta un dominio propio verificado y setear RESEND_FROM."
          : "Sin esto, quien denunció y dejó un email no recibe el enlace para ver el estado de su denuncia. La pantalla le dice lo mismo de siempre, así que espera un correo que nunca sale. También queda sin enviarse la entrega de exportaciones analíticas.",
    },
    {
      key: "webPush",
      label: "Notificaciones push",
      // Both halves of the VAPID pair are required; one alone is a
      // misconfiguration, not a partial capability.
      status: pushKeys.every((k) => present(env, k)) ? "configured" : "unconfigured",
      requires: pushKeys,
      consequence:
        "Sin esto, los avisos push no salen. Alcanza solo a quien ya tiene sesión y aceptó notificaciones en su navegador: nunca a un denunciante anónimo.",
    },
    {
      key: "sms",
      label: "SMS",
      // Not a deployment gap. There is no app-level SMS sender: the Twilio
      // block in supabase/config.toml belongs to Supabase Auth's own OTP, not
      // to us. Declared here so nobody writes copy promising an SMS.
      status: "not-built",
      requires: [],
      consequence:
        "No existe envío de SMS en la aplicación. Quien denunció dejando solo un teléfono no tiene ninguna vía digital de vuelta: debe presentar su código de constancia ante el organismo.",
    },
  ];
}

/**
 * True when every channel that COULD be configured in this environment is.
 * `not-built` channels are excluded: a product gap must not be reportable as
 * an environment failure an operator could fix by pasting a key.
 *
 * `restricted` is NOT ready. A channel that can only reach the provider
 * account's own mailbox reaches zero citizens, and calling that ready is the
 * same false comfort as calling an unset key ready — it just costs more to
 * discover, because the send appears to succeed.
 */
export function outboundChannelsReady(channels: readonly OutboundChannel[]): boolean {
  return channels.every((c) => c.status !== "unconfigured" && c.status !== "restricted");
}
