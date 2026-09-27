// /admin/designaciones — one jurisdiction administrator per province (SDD
// jurisdiction-admin, Phase 3).
//
// The platform admin sees the 24 provinces, who administers each, and for the
// selected province designates a funcionario or revokes the designation.
// A designation is platform-only: the page is gated by the /admin layout
// (requireAdminOrRedirect), and every write re-checks the platform-admin
// authority inside its transaction — and the database re-checks it again.
//
// (Not /admin/jurisdicciones: that path is a permanent 308 to /admin/reglas
// for old bookmarks — middleware.ts.)
//
// Container: loads the data and hands plain props to the forms.

import Link from "next/link";

import {
  OpButton,
  OpCard,
  OpCardBody,
  OpCardHead,
  OpPill,
  OpSelect,
} from "@/components/ui/dashboard";
import { db } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { PROVINCES, provinceByCode } from "@/lib/reference/ar-provincias";
import { formatDate } from "@/lib/utils/format";
import {
  listActiveAppointments,
  listAppointmentCandidates,
} from "@/src/modules/organizations/application/admin-authority/read-appointments";

import { AppointForm, RevokeForm } from "./_components/DesignationForms";

export const dynamic = "force-dynamic";

const DEFAULT_PROVINCE = "AR-B";

export default async function AdminDesignacionesPage({
  searchParams,
}: {
  searchParams: Promise<{ provincia?: string }>;
}) {
  await requireAdminOrRedirect();
  const { provincia } = await searchParams;
  const province =
    provinceByCode(provincia ?? DEFAULT_PROVINCE) ?? provinceByCode(DEFAULT_PROVINCE);
  const provinceCode = province?.code ?? DEFAULT_PROVINCE;
  const provinceName = province?.name ?? provinceCode;

  const active = await listActiveAppointments(db);
  const byProvince = new Map(active.map((a) => [a.provinceCode, a]));
  const selected = byProvince.get(provinceCode) ?? null;
  const candidates = selected ? [] : await listAppointmentCandidates(db, provinceCode);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="m-0 text-xl font-semibold text-ln-op-ink">
          Administradores jurisdiccionales
        </h1>
        <p className="mt-1 text-sm text-ln-op-mute">
          Cada provincia puede tener un administrador jurisdiccional: un funcionario que crea y da
          de baja funcionarios, confirma unidades y edita las reglas de su provincia, y de ninguna
          otra. Solo vos designás y revocás. Cada cambio queda registrado con quién lo hizo, cuándo
          y por qué.
        </p>
      </div>

      <form method="get" className="flex items-end gap-2">
        <div>
          <label
            htmlFor="admin-designaciones-provincia"
            className="block text-xs font-medium text-ln-op-ink-2"
          >
            Provincia
          </label>
          <OpSelect
            id="admin-designaciones-provincia"
            name="provincia"
            defaultValue={provinceCode}
            size="sm"
            block={false}
          >
            {PROVINCES.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </OpSelect>
        </div>
        <OpButton type="submit" variant="ghost" size="sm">
          Ver
        </OpButton>
      </form>

      <OpCard>
        <OpCardHead title={`Administración de ${provinceName}`} />
        <OpCardBody>
          {selected ? (
            <div className="space-y-3">
              <p className="m-0 text-sm text-ln-op-ink">
                <span className="font-medium">{selected.displayName}</span>
                {" · designado el "}
                {formatDate(selected.appointedAt)}
                {selected.appointedByName ? ` por ${selected.appointedByName}` : ""}
              </p>
              <p className="m-0 text-sm text-ln-op-ink-2">Motivo: {selected.appointmentReason}</p>
              {!selected.authorityLive && (
                <p className="m-0 text-sm text-ln-op-danger">
                  La designación sigue abierta pero no da permisos: la cuenta está desactivada o
                  perdió su concesión de toda la provincia. Revocala para cerrarla.
                </p>
              )}
              <RevokeForm
                appointmentId={selected.appointmentId}
                provinceCode={provinceCode}
                provinceName={provinceName}
                displayName={selected.displayName}
              />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="m-0 text-sm text-ln-op-mute">
                {provinceName} no tiene administrador jurisdiccional.
              </p>
              <AppointForm
                provinceCode={provinceCode}
                provinceName={provinceName}
                candidates={candidates.map((c) => ({
                  userId: c.userId,
                  label: c.hasWholeProvinceGrant
                    ? `${c.displayName} (ya tiene toda la provincia)`
                    : `${c.displayName} (recibe toda la provincia al designarlo)`,
                }))}
              />
            </div>
          )}
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Las 24 jurisdicciones" />
        <OpCardBody>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ln-op-mute">
                <th className="py-1 pr-3 font-medium">Provincia</th>
                <th className="py-1 pr-3 font-medium">Administrador jurisdiccional</th>
                <th className="py-1 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {PROVINCES.map((p) => {
                const a = byProvince.get(p.code);
                return (
                  <tr key={p.code} className="border-t border-ln-op-line">
                    <td className="py-1.5 pr-3">
                      <Link
                        href={`/admin/designaciones?provincia=${p.code}`}
                        className="text-ln-op-azul underline underline-offset-4"
                      >
                        {p.name}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3 text-ln-op-ink-2">{a ? a.displayName : "—"}</td>
                    <td className="py-1.5">
                      {!a ? (
                        <OpPill tone="neutral">Sin designar</OpPill>
                      ) : a.authorityLive ? (
                        <OpPill tone="ok">Activo</OpPill>
                      ) : (
                        <OpPill tone="danger">Sin permisos</OpPill>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </OpCardBody>
      </OpCard>
    </div>
  );
}
