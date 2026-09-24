"use client";

// PrintExpedienteButton — the "Imprimir" affordance for the maltrato
// expediente detail (Lote Q, Q6). Pairs with ./expediente-print.css: the
// button is screen-only chrome (the print sheet hides every button), and the
// print call goes through deferPrint so the click handler returns before the
// browser blocks on the dialog (the standard INP mitigation —
// lib/infra/defer-print.ts).

import { OpButton } from "@/components/ui/dashboard";
import { deferPrint } from "@/lib/infra/defer-print";

export function PrintExpedienteButton() {
  return (
    <OpButton type="button" variant="ghost" size="sm" onClick={() => deferPrint()}>
      Imprimir
    </OpButton>
  );
}
