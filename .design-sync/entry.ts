import "./process-shim";

// Curated design-system entry for the claude.ai/design sync (task #11).
// The converter synthesizes the bundle from THESE exports only — the scoped
// starter set approved by the PO. Expand this barrel on later re-syncs to
// grow the synced surface.
export { LnStatusFlag, LnVstamp } from "../components/ui/StatusFlag";
export { LnChip, LnChipGroup, LnStatusDot, LnPetPill } from "../components/ui/Chip";
export { OpKpi, OpKpiSm } from "../components/ui/dashboard/OpKpi";
export { LnField, LnInput, LnTextarea } from "../components/ui/Field";
export { LnRegRow, LnRegistry, LnPetPhoto } from "../components/ui/RegRow";
export { LnBadge } from "../components/ui/Badge";
