"use client";

import { LnButton } from "@/components/ui/Button";
import { LnInput } from "@/components/ui/Field";
import {
  isValidReferenceCodeFormat,
  normalizeReferenceCode,
} from "@/src/modules/welfare/domain/reference-code";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function SearchForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = normalizeReferenceCode(value);
    if (!isValidReferenceCodeFormat(code)) {
      setError("Código inválido. El formato es DEN-XXXX-XXXX.");
      return;
    }
    setError(null);
    router.push(`/denuncias/codigo/${code}`);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-[22px]"
    >
      <div className="space-y-1.5">
        <label
          htmlFor="code"
          className="block text-xs font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]"
          style={{ fontFamily: "var(--font-ln-mono)" }}
        >
          Código de seguimiento
        </label>
        {/* LnInput / LnButton instead of a hand-painted input and button. The
            hand-rolled pair measured 39px because it carried its own padding and
            never met the 44px floor Field.tsx has enforced since Wave 2
            (adversarial review 2026-08-08, S1-F07). `mono` is the primitive's
            own prop for a code field, replacing the inline fontFamily.
            The button takes size="lg" so the primary action matches the height
            of the field beside it — LnButton has no height floor, deliberately
            (buttons answer to WCAG 2.5.8 AA, 24px), so this is about the two
            controls in one row agreeing, not about compliance. */}
        <div className="flex items-stretch gap-2">
          <LnInput
            id="code"
            name="code"
            type="text"
            mono
            placeholder="DEN-XXXX-XXXX"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            className="flex-1 min-w-0 tracking-wide"
            autoComplete="off"
            spellCheck={false}
          />
          <LnButton type="submit" variant="primary" size="lg" className="flex-shrink-0">
            Buscar
          </LnButton>
        </div>
        {error && (
          <p className="text-sm text-[var(--color-ln-seal)]" role="alert">
            {error}
          </p>
        )}
        <p
          className="text-sm text-[var(--color-ln-mute)]"
          style={{ fontFamily: "var(--font-ln-mono)" }}
        >
          Formato: DEN-XXXX-XXXX · pegalo tal cual te lo enviamos.
        </p>
      </div>
    </form>
  );
}
