// Pins the outbound-channel readiness table.
//
// The defect this guards against is not a crash — it is a GREEN LIE. The
// denuncia access endpoint answers identically whether mail was sent or the
// mailer was never configured (anti-oracle, by design), so the operator screen
// is the only place the difference can be told. A channel that reports itself
// "configured" when it cannot send would put the last honest signal on the
// wrong side of the truth.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type EnvLike,
  FALLBACK_MAIL_SENDER,
  deriveOutboundChannels,
  outboundChannelsReady,
  resolveMailSender,
  senderIsProviderFallback,
} from "@/lib/infra/outbound-channels";

const FULLY_WIRED: EnvLike = {
  RESEND_API_KEY: "re_live_xxx",
  // Un dominio propio verificado. Sin esto el remitente cae al compartido del
  // proveedor y el canal queda RESTRINGIDO, no listo — que es exactamente lo
  // que pasa hoy en staging.
  //
  // El dominio es `mimar.com.ar` y no `mimar.ar` desde 2026-09-07: el segundo
  // NO EXISTE (sin NS ni MX en 8.8.8.8 ni 1.1.1.1), así que como ejemplo de
  // "dominio propio verificado" era falso en el único punto que importa — y
  // este valor es el que alguien copia al configurar RESEND_FROM de verdad.
  RESEND_FROM: "miMAR <noreply@mimar.com.ar>",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "BPub",
  VAPID_PRIVATE_KEY: "priv",
};

/** La forma real de staging al 2026-08-18: con clave, sin dominio propio. */
const SIN_DOMINIO_PROPIO: EnvLike = {
  RESEND_API_KEY: "re_live_xxx",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "BPub",
  VAPID_PRIVATE_KEY: "priv",
};

function channel(env: EnvLike, key: string) {
  const found = deriveOutboundChannels(env).find((c) => c.key === key);
  if (!found) throw new Error(`no channel ${key}`);
  return found;
}

// --- Escaneo de fuente para la fence del remitente -------------------------
// Extraído del `it` porque ahí adentro el linter medía complejidad 37 sobre un
// máximo de 25. Partirlo en piezas nombradas también hace legible QUÉ se
// escanea, que es la mitad del valor de una fence.

const ROOT = join(__dirname, "..");
/** Su casa: el único archivo donde el literal del fallback debe vivir. */
const CANONICO = "lib/infra/outbound-channels.ts";
const FROM_LITERAL = /from:\s*["'`][^"'`]*@[^"'`]+["'`]/;

/** Rutas relativas de todo el código de producto (sin tests). */
function archivosFuente(): string[] {
  const out: string[] = [];
  for (const raiz of ["app", "lib", "src"]) {
    for (const e of readdirSync(join(ROOT, raiz), { withFileTypes: true, recursive: true })) {
      const esFuente = e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"));
      if (!esFuente || e.name.includes(".test.")) continue;
      out.push(
        join(e.parentPath, e.name)
          .slice(ROOT.length + 1)
          .replaceAll("\\", "/"),
      );
    }
  }
  return out;
}

/** Líneas de código (no comentarios) que fijan una dirección de envío. */
function lineasConRemitenteFijo(rel: string): string[] {
  return readFileSync(join(ROOT, rel), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("//") && !l.startsWith("*"))
    .filter((l) => FROM_LITERAL.test(l))
    .map((l) => l.slice(0, 60));
}

describe("deriveOutboundChannels", () => {
  it("reports email unconfigured when the key is absent, and names what is missing", () => {
    const email = channel({}, "email");
    expect(email.status).toBe("unconfigured");
    // The operator must be told WHICH var to set — a red pill with no name
    // sends them reading source code.
    expect(email.requires).toContain("RESEND_API_KEY");
  });

  it("treats an empty or whitespace-only key as absent, not as configured", () => {
    // The failure this pins is real and has bitten this project before: an env
    // var set to "" is present as a KEY, so a `in`/`!== undefined` check calls
    // it configured while every send silently no-ops. Same shape as the empty
    // NEXT_PUBLIC_SITE_URL that made the credential QR encode a relative URL.
    expect(channel({ RESEND_API_KEY: "" }, "email").status).toBe("unconfigured");
    expect(channel({ RESEND_API_KEY: "   " }, "email").status).toBe("unconfigured");
  });

  it("requires BOTH halves of the VAPID pair before calling push configured", () => {
    // Half a key pair is a misconfiguration, not a partial capability.
    const onlyPublic = channel({ NEXT_PUBLIC_VAPID_PUBLIC_KEY: "BPub" }, "webPush");
    const onlyPrivate = channel({ VAPID_PRIVATE_KEY: "priv" }, "webPush");
    expect(onlyPublic.status).toBe("unconfigured");
    expect(onlyPrivate.status).toBe("unconfigured");
    expect(channel(FULLY_WIRED, "webPush").status).toBe("configured");
  });

  it("reports SMS as not-built in EVERY environment — no env var can turn it on", () => {
    // There is no app-level SMS sender at all. If some future env happened to
    // carry a Twilio key (Supabase Auth's own OTP block does), this must not
    // start claiming the product can text a reporter.
    for (const env of [{}, FULLY_WIRED, { TWILIO_AUTH_TOKEN: "x", RESEND_API_KEY: "y" }]) {
      const sms = channel(env, "sms");
      expect(sms.status).toBe("not-built");
      expect(sms.requires).toHaveLength(0);
    }
  });

  it("states the human consequence of every channel, not the module that is off", () => {
    // The card renders `consequence` verbatim to an operator deciding whether
    // it is safe to onboard real people. A blank or generic string here is the
    // whole feature failing quietly.
    for (const c of deriveOutboundChannels({})) {
      expect(c.consequence.length).toBeGreaterThan(40);
      expect(c.consequence).not.toMatch(/undefined|TODO/);
    }
    // The email consequence must name the stranded person specifically: since
    // the denuncia code page stopped rendering content, the emailed link is a
    // reporter's ONLY route to their own denuncia.
    expect(channel({}, "email").consequence).toMatch(/denunci/i);
  });

  it("la consecuencia CONCUERDA con la pastilla, no la contradice", () => {
    // ESTE ES EL TEST QUE FALTABA, y su ausencia costó un defecto en vivo.
    //
    // La consecuencia elegía su texto mirando solo el remitente, no el estado.
    // Como sin RESEND_FROM el remitente es el compartido haya clave o no, la
    // tarjeta mostró en staging la pastilla "SIN CONFIGURAR" con el párrafo del
    // estado restringido debajo: negaba estar configurada y a la vez explicaba
    // cómo estaba enviando.
    //
    // La aserción de arriba no lo cazó porque pedía que el texto contuviera
    // "denunci" — y AMBOS textos lo contienen. Una aserción que las dos ramas
    // satisfacen no distingue nada. Estas sí: cada estado exige una frase que
    // SOLO su rama tiene.
    expect(channel({}, "email").consequence).toMatch(/espera un correo que nunca sale/i);
    expect(channel({}, "email").consequence).not.toMatch(/remitente compartido/i);

    expect(channel(SIN_DOMINIO_PROPIO, "email").consequence).toMatch(/remitente compartido/i);
    expect(channel(SIN_DOMINIO_PROPIO, "email").consequence).not.toMatch(
      /espera un correo que nunca sale/i,
    );
  });

  it("never carries a secret VALUE, only variable names", () => {
    // The card is rendered in a React tree. A value on this object is one
    // serialization mistake away from the browser.
    const serialized = JSON.stringify(deriveOutboundChannels(FULLY_WIRED));
    expect(serialized).not.toContain("re_live_xxx");
    expect(serialized).not.toContain("priv");
    // Sanity: the names DO travel, so the assertion above is about values.
    expect(serialized).toContain("RESEND_API_KEY");
  });
});

// Tener la clave no es lo mismo que poder escribirle a una persona.
//
// El remitente estaba fijo en el código como `noreply@dim.ar`, un dominio que
// no existe: ningún proveedor envía desde un dominio que nadie verificó, así
// que todo envío habría sido rechazado con la clave puesta o sin ella. Sin
// dominio propio, la única dirección usable es la compartida del proveedor, y
// esa solo entrega a la casilla de la cuenta. Un tercer estado, porque las dos
// mentiras posibles son simétricas: verde diría que el aviso sale, y rojo
// escondería que el mecanismo anda.
describe("estado restringido — clave puesta, sin dominio propio", () => {
  it("no dice CONFIGURADO cuando el remitente es el compartido del proveedor", () => {
    expect(channel(SIN_DOMINIO_PROPIO, "email").status).toBe("restricted");
  });

  it("dice CONFIGURADO recién cuando hay un remitente con dominio propio", () => {
    // Control positivo: sin esto, un build que devolviera "restricted" siempre
    // satisfaría la aserción de arriba.
    expect(channel(FULLY_WIRED, "email").status).toBe("configured");
  });

  it("explica que a un denunciante cualquiera no le llega", () => {
    // La consecuencia es lo que el operador lee para decidir si puede abrir el
    // flujo a gente real. Un estado sin su explicación no sirve de nada.
    const c = channel(SIN_DOMINIO_PROPIO, "email");
    expect(c.consequence).toMatch(/solo entrega a la casilla de la cuenta/i);
    expect(c.consequence).toMatch(/RESEND_FROM/);
  });

  it("reconoce el remitente compartido aunque cambie el nombre visible", () => {
    // La detección va por el dominio del proveedor, no por igualdad de cadena:
    // "Equipo <onboarding@resend.dev>" sigue siendo el compartido.
    expect(senderIsProviderFallback("Equipo <onboarding@resend.dev>")).toBe(true);
    expect(senderIsProviderFallback("miMAR <noreply@mimar.com.ar>")).toBe(false);
  });

  it("usa el remitente configurado cuando existe, y el compartido cuando no", () => {
    expect(resolveMailSender(FULLY_WIRED)).toBe("miMAR <noreply@mimar.com.ar>");
    expect(resolveMailSender(SIN_DOMINIO_PROPIO)).toBe(FALLBACK_MAIL_SENDER);
    // Una cadena vacía NO es un remitente configurado — mismo criterio que el
    // resto del módulo aplica a las claves.
    expect(resolveMailSender({ RESEND_FROM: "   " })).toBe(FALLBACK_MAIL_SENDER);
  });
});

// El remitente no vuelve a quedar fijo en el código.
//
// Estuvo hardcodeado en DOS archivos como `miMAR <noreply@dim.ar>`, y el
// dominio no existía. Nadie lo notó porque un remitente inválido no rompe
// nada en desarrollo: falla recién en el envío real, contra un proveedor, en
// una rama que además se traga los errores a propósito para no ser un oráculo
// de existencia. O sea, el peor lugar posible para esconder una dirección
// inválida. Ahora sale de configuración y esta fence lo mantiene así.
describe("el remitente sale de configuración, no del código", () => {
  it("ningún archivo fija una dirección de envío", () => {
    const culpables = archivosFuente()
      .filter((rel) => rel !== CANONICO)
      .flatMap((rel) => lineasConRemitenteFijo(rel).map((l) => `${rel} → ${l}`));
    expect(culpables).toEqual([]);
  });

  it("escanea un árbol real, y el fallback vive en un solo lugar", () => {
    // NO VACUIDAD en las dos mitades: si el escaneo dejara de encontrar
    // archivos, la aserción de arriba pasaría sobre una lista vacía; y el
    // literal que SÍ debe existir tiene que seguir existiendo.
    expect(archivosFuente().length).toBeGreaterThan(500);
    expect(FALLBACK_MAIL_SENDER).toMatch(/@resend\.dev/);
  });
});

describe("outboundChannelsReady", () => {
  it("un canal restringido NO cuenta como listo", () => {
    // Alcanza a cero ciudadanos. Llamarlo listo es la misma falsa comodidad que
    // llamar listo a una clave sin setear, y cuesta más descubrirla porque el
    // envío parece tener éxito.
    expect(outboundChannelsReady(deriveOutboundChannels(SIN_DOMINIO_PROPIO))).toBe(false);
  });

  it("is true when every configurable channel is wired, despite SMS not existing", () => {
    // A product gap must not read as an environment failure an operator could
    // fix by pasting a key — otherwise this signal is red forever and stops
    // being read at all.
    expect(outboundChannelsReady(deriveOutboundChannels(FULLY_WIRED))).toBe(true);
  });

  it("is false while any configurable channel is missing its secrets", () => {
    expect(outboundChannelsReady(deriveOutboundChannels({}))).toBe(false);
    expect(outboundChannelsReady(deriveOutboundChannels({ RESEND_API_KEY: "re_live_xxx" }))).toBe(
      false,
    );
  });
});
