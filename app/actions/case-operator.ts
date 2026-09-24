"use server";

// case-operator.ts — los tres server actions del detalle de caso (#41).
//
// Capa fina: guard, delegación al use-case, revalidate. La lógica —qué acciones
// admite cada kind, el orden mutación-antes-de-evento, la carrera de cierre, y
// el fan-out sin el cual una escalada no es una escalada— vive en
// src/modules/cases/application/operator-actions.ts.
//
// La tercera (escalar) llegó el 2026-09-17 y cierra #41. Hasta ese día escalar
// existía SÓLO por cron: una disputa subía a los 365 días, un handoff de
// decomiso trabado a los 7. El operador que veía hoy que hacía falta otra
// mirada no tenía cómo pedirla.
//
// AUTORIZACIÓN. `requireCaseOperatorPrincipal` es admin | govt, igual que
// decomiso y moderación de denuncias, y por la misma razón que
// `lib/infra/auth-guards.ts` deja escrita para el decomiso: asentar en un
// expediente o darlo por terminado es un acto de la autoridad, no algo que una
// membresía de organización pueda conferir. Un refugio no cierra un expediente
// de custodia aunque tenga al animal.
//
// El alcance jurisdiccional del govt lo enforcea `canReadCase` en la pantalla
// que monta estos controles; acá se re-verifica la lectura antes de escribir,
// porque una server action es invocable directamente y la pantalla no es un
// guard.

import { revalidatePath } from "next/cache";

import { cases, db } from "@/db";
import { eq } from "drizzle-orm";

import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { canReadCase } from "@/lib/infra/case-access";
import { getCaseDetailByPublicCode } from "@/lib/infra/case-queries";
import { getJurisdictionsCached } from "@/lib/infra/request-cache";
import {
  addOperatorNote as _addOperatorNote,
  closeCaseManually as _closeCaseManually,
  escalateCaseManually as _escalateCaseManually,
} from "@/src/modules/cases/application/operator-actions";

type Result = { ok: true } | { error: string };

/**
 * Guard compartido: rol correcto Y lectura del expediente concreto.
 *
 * Los dos chequeos son necesarios y ninguno alcanza solo. El rol dice que es
 * una autoridad; `canReadCase` dice que ES autoridad SOBRE ESTE expediente —
 * un funcionario de CABA no asienta en un caso de Salta.
 */
// Toma la sesión YA resuelta por el llamador. El guard se llama en cada action
// y no acá adentro, a propósito: check-authz-guards busca la llamada al guard en
// el cuerpo de la función exportada, y esconderla en un helper la vuelve
// invisible para la reja. Tiene razón — el guard de una server action tiene que
// verse en su punto de entrada, que es donde alguien lo va a buscar.
async function assertCaseInScope(
  session: Awaited<ReturnType<typeof requireAdminOrGovtOrRedirect>>,
  publicCode: string,
): Promise<{ userId: string } | { error: string }> {
  const detail = await getCaseDetailByPublicCode(publicCode);
  if (!detail) return { error: "Expediente no encontrado." };

  const jurisdictions =
    session.profile.role === "govt" ? await getJurisdictionsCached(session.profile.id) : [];

  const allowed = await canReadCase(detail, {
    userId: session.profile.id,
    role: session.profile.role,
    jurisdictions,
  });
  if (!allowed) return { error: "Expediente no encontrado." };

  return { userId: session.profile.id };
}

async function revalidateCase(publicCode: string): Promise<void> {
  const [row] = await db
    .select({ kind: cases.caseKind })
    .from(cases)
    .where(eq(cases.publicCode, publicCode))
    .limit(1);
  revalidatePath(`/casos/${publicCode}`);
  revalidatePath("/gob/casos");
  revalidatePath("/gob/acciones");
  if (row) revalidatePath("/gob");
}

export async function addCaseNoteAction(publicCode: string, text: string): Promise<Result> {
  const session = await requireAdminOrGovtOrRedirect();
  const auth = await assertCaseInScope(session, publicCode);
  if ("error" in auth) return { error: auth.error };

  const res = await _addOperatorNote({ publicCode, actorUserId: auth.userId, text });
  if (!res.ok) return { error: res.error };

  await revalidateCase(publicCode);
  return { ok: true };
}

export async function closeCaseAction(publicCode: string, reason: string): Promise<Result> {
  const session = await requireAdminOrGovtOrRedirect();
  const auth = await assertCaseInScope(session, publicCode);
  if ("error" in auth) return { error: auth.error };

  const res = await _closeCaseManually({ publicCode, actorUserId: auth.userId, reason });
  if (!res.ok) return { error: res.error };

  await revalidateCase(publicCode);
  return { ok: true };
}

/**
 * Escala el expediente a la autoridad, ahora.
 *
 * MISMA PUERTA DE AUTORIZACIÓN que nota y cierre, y no es por comodidad: subir
 * un expediente a una autoridad de la jurisdicción es un acto de la autoridad,
 * no algo que una membresía de organización pueda conferir. `assertCaseInScope`
 * es lo que impide que un funcionario escale un expediente de otra provincia.
 */
export async function escalateCaseAction(publicCode: string, reason: string): Promise<Result> {
  const session = await requireAdminOrGovtOrRedirect();
  const auth = await assertCaseInScope(session, publicCode);
  if ("error" in auth) return { error: auth.error };

  const res = await _escalateCaseManually({ publicCode, actorUserId: auth.userId, reason });
  if (!res.ok) return { error: res.error };

  await revalidateCase(publicCode);
  return { ok: true };
}
