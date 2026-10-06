// The web SECTIONS a notification may lead to, and who may enter each one
// (notificaciones-destinos review, 2026-10).
//
// WHY A LIST AND NOT "ANY PATH THE WRITER STORED". A `cta_url` is a string
// chosen at send time. Routes get renamed, and a section the resolver hands out
// on faith is a 404 the day after the rename — the exact failure this change
// exists to remove. So the resolver opens a stored section only when it matches
// a pattern here; anything else falls to the explanation state.
// `__tests__/deep-link-map.test.ts` checks every pattern against `app/`, so a
// rename turns CI red instead of turning notifications into 404s.
//
// ACCESS is what the PAGE enforces, transcribed:
//   · `public`  — anybody holding the link;
//   · `session` — any signed-in account; the page renders its own state;
//   · `org`     — an ACTIVE member of the org named by `:orgToken`, plus the
//                 capability the page gates on when it hard-gates one;
//   · `roles`   — the portal's role gate (`/gob`, `/admin`).
//
// Zero runtime dependencies.

export type NotificationSectionAccess =
  | { kind: "public" }
  | { kind: "session" }
  | { kind: "org"; capability?: string }
  | { kind: "roles"; roles: readonly ("owner" | "vet" | "govt" | "admin" | "national")[] };

export type NotificationSection = {
  /** Web path with `:name` placeholders, no query. */
  readonly pattern: string;
  readonly access: NotificationSectionAccess;
};

const PUBLIC = { kind: "public" } as const;
const SESSION = { kind: "session" } as const;
const ORG = { kind: "org" } as const;
const GOB = { kind: "roles", roles: ["govt", "admin", "national"] } as const;
const ADMIN = { kind: "roles", roles: ["admin", "national"] } as const;

export const NOTIFICATION_SECTIONS: readonly NotificationSection[] = [
  { pattern: "/adoptar", access: PUBLIC },
  { pattern: "/p/:publicToken", access: PUBLIC },
  { pattern: "/denuncias/codigo/:referenceCode", access: PUBLIC },
  { pattern: "/iniciar-sesion", access: PUBLIC },
  { pattern: "/sugerencias", access: PUBLIC },
  { pattern: "/cuenta", access: SESSION },
  { pattern: "/cuenta/solicitudes", access: SESSION },
  { pattern: "/cuenta/upgrade", access: SESSION },
  { pattern: "/cuenta/chapas", access: SESSION },
  { pattern: "/cuenta/ofrecerme-como-transito", access: SESSION },
  { pattern: "/cuenta/transitos/propuestas", access: SESSION },
  { pattern: "/cuenta/transitos/propuestas/:proposalToken", access: SESSION },
  { pattern: "/cuenta/transitos/historial", access: SESSION },
  { pattern: "/mis-mascotas", access: SESSION },
  { pattern: "/mis-mascotas/nueva", access: SESSION },
  { pattern: "/mis-mascotas/postulaciones", access: SESSION },
  { pattern: "/mis-turnos", access: SESSION },
  { pattern: "/transferencias", access: SESSION },
  { pattern: "/transferencias/:transferToken", access: SESSION },
  { pattern: "/cuidado/:grantToken", access: SESSION },
  { pattern: "/org", access: SESSION },
  { pattern: "/org/:orgToken", access: ORG },
  { pattern: "/org/:orgToken/adopciones", access: ORG },
  {
    pattern: "/org/:orgToken/adopciones/:appEventId",
    access: { kind: "org", capability: "adoption.review" },
  },
  {
    pattern: "/org/:orgToken/admin/permisos",
    access: { kind: "org", capability: "capability.grant" },
  },
  { pattern: "/org/:orgToken/transferencias/recibidas", access: ORG },
  { pattern: "/org/:orgToken/voluntarios/propuestas", access: ORG },
  { pattern: "/org/:orgToken/mascotas", access: ORG },
  { pattern: "/org/:orgToken/miembros", access: ORG },
  { pattern: "/org/:orgToken/mensajes", access: ORG },
  { pattern: "/org/:orgToken/servicios", access: ORG },
  { pattern: "/org/:orgToken/servicios/:offeringToken", access: ORG },
  { pattern: "/org/:orgToken/casos", access: ORG },
  { pattern: "/org/:orgToken/maltrato/recibidos", access: ORG },
  { pattern: "/gob", access: GOB },
  { pattern: "/gob/vigilancia", access: GOB },
  { pattern: "/gob/cola", access: GOB },
  { pattern: "/gob/directorio", access: GOB },
  { pattern: "/gob/maltrato/:reportId", access: GOB },
  { pattern: "/admin/cola", access: ADMIN },
  { pattern: "/admin/cola/:approvalToken", access: ADMIN },
  { pattern: "/admin/observaciones", access: ADMIN },
  { pattern: "/admin/casos", access: ADMIN },
  { pattern: "/admin/govts/:userId", access: ADMIN },
];

/**
 * The section a concrete path names, with its placeholder values — or `null`
 * when the path is not a known section. Query and fragment are ignored; a
 * trailing slash is not a different page.
 */
export function matchNotificationSection(
  path: string,
): { section: NotificationSection; params: Record<string, string> } | null {
  const clean = trimTrailingSlash(path.split("#")[0]?.split("?")[0] ?? "");
  const segments = clean.split("/");
  for (const section of NOTIFICATION_SECTIONS) {
    const pattern = section.pattern.split("/");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (const [i, expected] of pattern.entries()) {
      const actual = segments[i] ?? "";
      if (expected.startsWith(":")) {
        if (actual === "") {
          ok = false;
          break;
        }
        params[expected.slice(1)] = actual;
      } else if (expected !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) return { section, params };
  }
  return null;
}

/** `/a/b/` → `/a/b`; the root stays `/`. */
export function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/** The erasure sentinel `erase_subject_data` writes into a notification's title. */
export const ERASED_NOTIFICATION_TITLE = "[eliminado]";

/** An erased row says nothing more: no destination, no button. */
export function isErasedNotification(row: { title: string }): boolean {
  return row.title === ERASED_NOTIFICATION_TITLE;
}

/**
 * A same-origin web PATH, safe to hand to a redirect or a `<Link>`.
 *
 * Refuses what a browser would resolve to ANOTHER origin: a scheme or a
 * protocol-relative `//host`, and the spellings that become one after URL
 * parsing strips them — a backslash (`/\evil.com`) or an ASCII control
 * character (`/\t/evil.com`). What is left — one leading slash, then no
 * backslash and no control character — cannot leave the origin it is resolved
 * against. (No `URL` here: this package compiles without the DOM or Node lib.)
 */
export function isSafeInternalPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** Scheme, then a host with no userinfo, then a path, query, fragment or the end. */
const EXTERNAL_URL = /^https?:\/\/[^/?#@]+(?:[/?#]|$)/i;

/** An absolute http(s) URL a notification may link out to. */
export function isSafeExternalUrl(url: string): boolean {
  if (url.includes("\\")) return false;
  for (let i = 0; i < url.length; i += 1) {
    const code = url.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return EXTERNAL_URL.test(url);
}
