"use client";

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { Sheet } from "@/components/ui/VaulSheet";
import type { DonationMethods } from "@/lib/infra/org-public-profile";
import { buildCloseSheetUrl } from "@/lib/ui/sheet-helpers";
import { closeSheetNav } from "@/lib/ui/sheet-nav";
import { usePathname, useSearchParams } from "next/navigation";

// "Doná" sheet — exposes whichever donation channels the org filled in
// `organizations.donation_methods` (P1-1 JSONB). Render is purely
// conditional on which keys are present; missing keys are silently
// omitted (no greyed-out rows).
//
// Handoff P2-9. The HelpPanel only mounts the Donar CTA when at least
// one method is set, so this sheet should always have something to
// render — but we still guard for the empty case as defense.

interface Props {
  orgDisplayName: string;
  methods: DonationMethods | null;
}

type Row = { label: string; value: string; href?: string; copyable: boolean };

function buildRows(methods: DonationMethods): Row[] {
  const rows: Row[] = [];
  if (methods.cbu) rows.push({ label: "CBU", value: methods.cbu, copyable: true });
  if (methods.cvu) rows.push({ label: "CVU", value: methods.cvu, copyable: true });
  if (methods.alias) rows.push({ label: "Alias", value: methods.alias, copyable: true });
  if (methods.mpLink)
    rows.push({
      label: "Mercado Pago",
      value: methods.mpLink,
      href: methods.mpLink,
      copyable: false,
    });
  if (methods.btcAddress)
    rows.push({ label: "Bitcoin", value: methods.btcAddress, copyable: true });
  return rows;
}

export function DonarSheet({ orgDisplayName, methods }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const open = searchParams.get("sheet") === "donar";
  const rows = methods ? buildRows(methods) : [];

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <Sheet
      id="donar"
      title={`Doná a ${orgDisplayName}`}
      open={open}
      onClose={() => closeSheetNav(buildCloseSheetUrl(pathname, searchParams))}
      size="md"
    >
      <div className="space-y-4">
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--color-ln-mute)]">
            {orgDisplayName} todavía no publicó canales de donación.
          </p>
        ) : (
          <>
            <p className="text-sm text-[var(--color-ln-ink-2)]">
              Cualquier monto ayuda. {orgDisplayName} decide cómo se usa cada peso.
            </p>
            <ul className="space-y-2">
              {rows.map((row) => (
                <li
                  key={row.label}
                  className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-3"
                >
                  <p className="text-xs uppercase tracking-wider text-[var(--color-ln-mute)]">
                    {row.label}
                  </p>
                  {row.href ? (
                    <a
                      href={row.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-sm font-medium text-[var(--color-ln-azul)] underline break-all"
                    >
                      Abrir link →
                    </a>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-ln-mono text-[var(--color-ln-ink)] break-all flex-1">
                        {row.value}
                      </p>
                      {row.copyable && (
                        <button
                          type="button"
                          onClick={() => copy(row.label, row.value)}
                          className="flex items-center gap-1 text-xs text-[var(--color-ln-azul)] hover:underline shrink-0"
                        >
                          {copiedKey === row.label ? (
                            <>
                              <Icon name="check" size="sm" decorative /> Copiado
                            </>
                          ) : (
                            "Copiar"
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Sheet>
  );
}
