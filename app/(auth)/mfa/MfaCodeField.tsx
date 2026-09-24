import { LnField, LnInput } from "@/components/ui/Field";

// The six-digit code input both /mfa steps use. `one-time-code` lets the
// platform offer the code from an authenticator or password manager.
export function MfaCodeField() {
  return (
    <LnField label="Código de verificación" required hint="6 números, cambian cada 30 segundos.">
      {({ id, describedBy, invalid }) => (
        <LnInput
          id={id}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          mono
          aria-describedby={describedBy}
          invalid={invalid}
        />
      )}
    </LnField>
  );
}
