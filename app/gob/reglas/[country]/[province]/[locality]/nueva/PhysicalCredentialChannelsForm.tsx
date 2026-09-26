"use client";

// PhysicalCredentialChannelsForm — admin/govt form for the
// physical_credential_channels rule type (design ADR-5, R3.1-R3.4).
// Follows the PppBreedListForm/PppAttestationRegistriesForm template.
//
// No enforcement hook (config-only, reevalHook=null) — saving this rule
// never triggers a reeval sweep or an impact-preview gate, so unlike
// PppBreedListForm there is no RuleImpactBanner here.

import { useActionState, useEffect, useState } from "react";

import {
  type BusinessRuleFormState,
  createBusinessRuleAction,
  updateBusinessRuleAction,
} from "@/app/actions/business-rules";
import { LnCheckbox, LnField, LnInput, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

import { LegalMetadataFieldset, type LegalMetadataInitial } from "./LegalMetadataFieldset";
import { RulePlaceField } from "./RulePlaceField";

const initialState: BusinessRuleFormState = { error: null };

type ProviderChannel = { enabled: boolean; providerName?: string; providerUrl?: string };

type Props = {
  mode: "create" | "edit";
  ruleId?: string;
  country: string;
  province: string | null;
  locality: string | null;
  base: "/admin" | "/gob";
  initialPrintableQr: boolean;
  initialEngravedPlate: ProviderChannel;
  initialNfcTag: ProviderChannel;
  initialNotes: string;
  initialLegalMetadata?: LegalMetadataInitial;
};

function ProviderFields({
  channelKey,
  legend,
  enabled,
  onEnabledChange,
  providerName,
  onProviderNameChange,
  providerUrl,
  onProviderUrlChange,
  keptChecked,
}: {
  channelKey: string;
  legend: string;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  providerName: string;
  onProviderNameChange: (v: string) => void;
  providerUrl: string;
  onProviderUrlChange: (v: string) => void;
  /** From useKeptFields — re-seeds this checkbox after a reset. */
  keptChecked: (name: string, fallback: boolean) => boolean;
}) {
  return (
    <fieldset className="space-y-2 rounded-[var(--radius-md)] border border-ln-op-line p-3">
      <legend className="text-md font-medium text-ln-op-ink">{legend}</legend>
      <LnCheckbox
        name={`enabled_${channelKey}`}
        defaultChecked={keptChecked(`enabled_${channelKey}`, enabled)}
        onChange={(e) => onEnabledChange(e.target.checked)}
      >
        Habilitado
      </LnCheckbox>
      {enabled && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <LnInput
            type="text"
            name={`provider_name_${channelKey}`}
            placeholder="Nombre del proveedor"
            value={providerName}
            onChange={(e) => onProviderNameChange(e.target.value)}
          />
          <LnInput
            type="url"
            name={`provider_url_${channelKey}`}
            placeholder="https://proveedor.example"
            value={providerUrl}
            onChange={(e) => onProviderUrlChange(e.target.value)}
          />
        </div>
      )}
    </fieldset>
  );
}

export function PhysicalCredentialChannelsForm({
  mode,
  ruleId,
  country,
  province,
  locality,
  base,
  initialPrintableQr,
  initialEngravedPlate,
  initialNfcTag,
  initialNotes,
  initialLegalMetadata,
}: Props) {
  const action =
    mode === "edit" && ruleId
      ? updateBusinessRuleAction.bind(null, ruleId)
      : createBusinessRuleAction;
  // forms/react19-reset-data-loss-inventory: printableQr and both channels'
  // `enabled` checkboxes were controlled with checked=/onChange= — the exact
  // pair the react19-form-reset-contract measures as vulnerable regardless
  // (falls back to its MOUNT value). `notes` had a STATIC defaultValue. The
  // provider name/url text fields are already controlled and survive on
  // their own.
  const { boundAction, kept, keptChecked } = useKeptFields<BusinessRuleFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  // Router-drop workaround (verify-report #650 WARNING-1) — see
  // lib/ui/full-page-action-nav.ts's module docblock.
  useEffect(() => {
    if (state.redirectTo) navigateAfterActionSuccess(state.redirectTo);
  }, [state.redirectTo]);

  const [printableQr, setPrintableQr] = useState(initialPrintableQr);
  const [engravedEnabled, setEngravedEnabled] = useState(initialEngravedPlate.enabled);
  const [engravedName, setEngravedName] = useState(initialEngravedPlate.providerName ?? "");
  const [engravedUrl, setEngravedUrl] = useState(initialEngravedPlate.providerUrl ?? "");
  const [nfcEnabled, setNfcEnabled] = useState(initialNfcTag.enabled);
  const [nfcName, setNfcName] = useState(initialNfcTag.providerName ?? "");
  const [nfcUrl, setNfcUrl] = useState(initialNfcTag.providerUrl ?? "");

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="ruleType" value="physical_credential_channels" />
      <input type="hidden" name="jurisdictionCountry" value={country} />
      <input type="hidden" name="jurisdictionProvince" value={province ?? ""} />
      <input type="hidden" name="jurisdictionLocality" value={locality ?? ""} />
      <RulePlaceField />
      <input type="hidden" name="portalBase" value={base} />

      <p className="text-md text-ln-op-ink-2">
        Qué canales de credencial física están disponibles para esta jurisdicción. Consumido por la
        ficha de mascota (chapita) para mostrar las opciones habilitadas al dueño.
      </p>

      <LnCheckbox
        name="printable_qr"
        defaultChecked={keptChecked("printable_qr", printableQr)}
        onChange={(e) => setPrintableQr(e.target.checked)}
      >
        QR imprimible en casa
      </LnCheckbox>

      <ProviderFields
        channelKey="engraved_plate"
        legend="Placa grabada"
        enabled={engravedEnabled}
        onEnabledChange={setEngravedEnabled}
        providerName={engravedName}
        onProviderNameChange={setEngravedName}
        providerUrl={engravedUrl}
        onProviderUrlChange={setEngravedUrl}
        keptChecked={keptChecked}
      />

      <ProviderFields
        channelKey="nfc_tag"
        legend="Chapita NFC"
        enabled={nfcEnabled}
        onEnabledChange={setNfcEnabled}
        providerName={nfcName}
        onProviderNameChange={setNfcName}
        providerUrl={nfcUrl}
        onProviderUrlChange={setNfcUrl}
        keptChecked={keptChecked}
      />

      <LegalMetadataFieldset initial={initialLegalMetadata} />

      <LnField label="Notas internas">
        {({ id, describedBy, invalid }) => (
          <LnTextarea
            id={id}
            name="notes"
            defaultValue={kept("notes", initialNotes)}
            rows={3}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {state.warning && <p className="text-md text-ln-op-warn">{state.warning}</p>}
      {state.error && (
        <p className="text-md text-ln-op-danger" role="alert">
          {state.error}
        </p>
      )}

      <OpButton type="submit" disabled={isPending} loading={isPending} variant="primary" block>
        {isPending ? "Guardando..." : mode === "create" ? "Crear regla" : "Guardar cambios"}
      </OpButton>
    </form>
  );
}
