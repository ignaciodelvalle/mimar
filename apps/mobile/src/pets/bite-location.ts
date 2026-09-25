// The bite form's map point, between the draft's strings and the picker (M17).
//
// The draft stores every field as a string (it is persisted and compared field
// by field), so the confirmed pick lives there as `biteLat`/`biteLng`/
// `biteLocationSource`. This rebuilds the picker's value from them, so the map
// reopens on the point already chosen — including one restored from a draft.

import type { PickedLocation } from "../ui/LocationPicker";
import type { EventDraft } from "./record-event-view-model";

export function bitePickedLocation(draft: EventDraft): PickedLocation | null {
  const lat = Number.parseFloat(draft.biteLat);
  const lng = Number.parseFloat(draft.biteLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    address: draft.locationDescription.trim() || null,
    source: draft.biteLocationSource === "geocodificada" ? "geocodificada" : "pin_manual",
    jurisdiction: null,
  };
}
