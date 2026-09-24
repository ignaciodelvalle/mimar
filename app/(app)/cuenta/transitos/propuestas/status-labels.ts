// Shared foster-proposal status labels (es-AR). Colocated (not a route file)
// so both the inbox list and the proposal detail page can import it — Next.js
// forbids extra named exports from page.tsx.
export const STATUS_LABELS = {
  pending: "Pendiente",
  accepted: "Aceptada",
  rejected: "Rechazada",
  expired: "Expirada",
  cancelled: "Cancelada",
} as const;
