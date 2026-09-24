"use client";

// Toaster — thin wrapper around sonner that sets the DIM defaults (position,
// auto-dismiss, theme) so consumers don't have to think about them.
//
// Usage:
//   import { Toaster } from "@/components/Toaster";
//   <Toaster />        ← mounted once in app/layout.tsx
//
// For firing toasts, import `toast` from sonner directly:
//   import { toast } from "sonner";
//   toast.success("Vacuna registrada")
//   toast.error("Sesión expirada", { duration: 7000 })

import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      position="top-center"
      // 4s for normal toasts, 7s for errors — sonner honors a per-toast
      // duration override, but this is the default.
      duration={4000}
      richColors
      closeButton
      // top-center on mobile, top-right on desktop. sonner doesn't have a
      // built-in switch so we leave it at top-center for both; works on
      // narrow viewports + doesn't hijack desktop scrollbars either.
    />
  );
}
