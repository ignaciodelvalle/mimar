// The gate of every /gob/administracion page (jurisdiction-admin Phase 6).
//
// requireAdministrationPrincipalOrRedirect admits the platform admin or a govt
// with a LIVE appointment (a plain govt, a revoked or deactivated appointee go
// home). This portal is the appointee's view of ONE province, so the platform
// admin — who administers every province from /admin — is sent there instead.
//
// What it returns is WHERE the pages look, never what the writers allow: each
// action behind these pages re-derives its target's province and re-checks the
// actor inside its own transaction.

import { redirect } from "next/navigation";

import { requireAdministrationPrincipalOrRedirect } from "@/lib/infra/auth-guards";
import { provinceByCode } from "@/lib/reference/ar-provincias";

export type ProvinceAdministration = {
  viewerId: string;
  provinceCode: string;
  provinceName: string;
};

export async function requireProvinceAdministrationOrRedirect(): Promise<ProvinceAdministration> {
  const session = await requireAdministrationPrincipalOrRedirect();
  if (session.authority.kind !== "jurisdiction") redirect("/admin");
  const provinceCode = session.authority.provinceCode;
  return {
    viewerId: session.user.id,
    provinceCode,
    provinceName: provinceByCode(provinceCode)?.name ?? provinceCode,
  };
}

/** The base path of every page of this portal. */
export const ADMINISTRACION_BASE = "/gob/administracion";
