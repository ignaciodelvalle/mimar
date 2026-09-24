// /org/[orgToken]/mensajes — bandeja de mensajes públicos de la organización.
//
// POR QUÉ EXISTE (auditoría 2026-08-04). Las dos sheets públicas del perfil de
// refugio — "Contactar" y "Sumate como voluntario" — escribían en
// `org_contact_messages` y **nada leía esa tabla**: no había página, no había
// email, y el caso de uso devolvía `notifications: []`. Mientras tanto la copy
// prometía "¡Tu mensaje llegó!" y "te contactan por email". Cada persona que se
// ofreció como voluntaria le habló a una tabla que nadie podía abrir.
//
// Esta página es la mitad que faltaba: el aviso (submit-org-contact.ts) le dice
// a los admins que hay algo, y esto es donde lo leen. Incluye los mensajes ya
// acumulados desde el lanzamiento — no sólo los nuevos.
//
// Acceso: `member.invite` — la misma vara que "Miembros", el permiso que
// representa "administro esta organización de cara afuera". El gate está en la
// PÁGINA y en la navegación, no sólo en la nav: los mensajes traen email y
// texto libre de un tercero, así que un miembro sin ese permiso tampoco debe
// leerlos tipeando la URL.

import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpCrumbs } from "@/components/ui/dashboard";
import { db, orgContactMessages } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { AR_TIME_ZONE } from "@/lib/utils/format";
import { capRows } from "@/lib/utils/list-pagination";
import { requireCapability } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";

const PAGE_SIZE = 50;

const FMT = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: AR_TIME_ZONE,
});

export default async function MensajesPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization } = await requireOrgAccessByToken(orgToken);
  // A page READ: a deactivated institutional account keeps it, per
  // lib/infra/auth-guards.ts:60-70 — reads stay open, writes stop.
  const auth = await requireCapability("member.invite", organization.id, { access: "read" });
  if (auth.error !== null) {
    return (
      <div className="max-w-2xl space-y-4 py-8">
        <h1 className="text-title font-semibold text-ln-op-ink">Sin acceso</h1>
        <p className="text-md text-ln-op-mute">{auth.error}</p>
        <Link
          href={`/org/${orgToken}`}
          className="text-md text-ln-op-azul hover:underline no-underline"
        >
          ← Volver al panel
        </Link>
      </div>
    );
  }

  // Fetch one extra row to detect truncation honestly (misma convención que
  // /voluntarios: nunca mostrar una página parcial como si fuera todo).
  const rows = await db
    .select({
      id: orgContactMessages.id,
      kind: orgContactMessages.kind,
      inquirerName: orgContactMessages.inquirerName,
      inquirerEmail: orgContactMessages.inquirerEmail,
      message: orgContactMessages.message,
      createdAt: orgContactMessages.createdAt,
    })
    .from(orgContactMessages)
    .where(eq(orgContactMessages.organizationId, organization.id))
    .orderBy(desc(orgContactMessages.createdAt))
    .limit(PAGE_SIZE + 1);

  const { rows: mensajes, truncated } = capRows(rows, PAGE_SIZE);

  return (
    <div className="space-y-4">
      <OpCrumbs
        items={[
          { label: organization.displayName, href: `/org/${orgToken}` },
          { label: "Mensajes" },
        ]}
      />

      <header>
        <h1 className="text-lg font-semibold text-ln-op-ink">Mensajes</h1>
        <p className="mt-1 text-sm text-ln-op-mute">
          Consultas y ofrecimientos de voluntariado que llegaron desde el perfil público de{" "}
          {organization.displayName}. Responder es por fuera de miMAR: escribile al correo que dejó
          cada persona.
        </p>
      </header>

      {mensajes.length === 0 ? (
        <LnEmptyState
          icon="mensaje"
          title="Todavía no hay mensajes"
          description="Cuando alguien escriba desde el perfil público o se ofrezca como voluntario/a, va a aparecer acá."
        />
      ) : (
        <>
          <ul className="space-y-3">
            {mensajes.map((m) => (
              <li
                key={m.id}
                className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium text-ln-op-ink">
                    {m.inquirerName?.trim() || "Sin nombre"}
                    <span className="ml-2 rounded-full border border-ln-op-line px-2 py-0.5 text-xs font-normal text-ln-op-mute">
                      {m.kind === "volunteer" ? "Voluntariado" : "Consulta"}
                    </span>
                  </p>
                  <time className="text-xs text-ln-op-mute">{FMT.format(m.createdAt)}</time>
                </div>
                <p className="mt-1 text-sm">
                  <a
                    href={`mailto:${m.inquirerEmail}`}
                    className="text-ln-op-azul underline underline-offset-2"
                  >
                    {m.inquirerEmail}
                  </a>
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-ln-op-ink">{m.message}</p>
              </li>
            ))}
          </ul>
          {truncated && (
            <p className="text-xs text-ln-op-mute">Mostrando los {PAGE_SIZE} más recientes.</p>
          )}
        </>
      )}
    </div>
  );
}
