// The org bite wizard's submission, built from its controlled fields.
//
// Pure and separate from OrgBiteForm.tsx so the wire contract — what
// `reportBiteFromOrgAction` receives — is tested without driving a four-step
// wizard. The wizard builds its FormData by hand (it is controlled state, not a
// <form> with hidden inputs), which is exactly how the INDEC id the locality
// picker resolved used to be dropped (localidades-por-id A2): nothing here had
// a field for it.

export type OrgBiteFields = {
  clientIdempotencyKey: string;
  petPublicToken: string;
  occurredAt: string;
  locationDescription: string;
  provinceCode: string;
  provinceName: string;
  localityName: string;
  /** INDEC id of the row picked in LocalityPickerAcross; "" when none. */
  localityIndecId: string;
  victimKind: "human" | "animal" | "unknown";
  victimContactName: string;
  victimContactPhone: string;
  victimAgeEstimate: string;
  severity: string;
  injuriesSummary: string;
  vetInvolved: boolean;
  context: string;
  confirmObservation: boolean;
  point: { lat: number; lng: number } | null;
  locationSource: "pin_manual" | null;
};

export function buildOrgBiteFormData(f: OrgBiteFields): FormData {
  const fd = new FormData();
  fd.set("clientIdempotencyKey", f.clientIdempotencyKey);
  fd.set("petPublicToken", f.petPublicToken.trim());
  fd.set("occurredAt", f.occurredAt);
  if (f.locationDescription) fd.set("locationDescription", f.locationDescription);
  if (f.provinceCode) fd.set("provinceCode", f.provinceCode);
  if (f.provinceName) fd.set("provinceName", f.provinceName);
  if (f.localityName) fd.set("localityName", f.localityName);
  // The row the operator tapped. Without it the server has only a NAME, and a
  // name two localities share cannot say which one was meant.
  if (f.localityIndecId) fd.set("localityNameIndecId", f.localityIndecId);
  fd.set("victimKind", f.victimKind);
  if (f.victimContactName) fd.set("victimContactName", f.victimContactName);
  if (f.victimContactPhone) fd.set("victimContactPhone", f.victimContactPhone);
  if (f.victimAgeEstimate) fd.set("victimAgeEstimate", f.victimAgeEstimate);
  fd.set("severity", f.severity);
  if (f.injuriesSummary) fd.set("injuriesSummary", f.injuriesSummary);
  if (f.vetInvolved) fd.set("vetInvolved", "on");
  if (f.context) fd.set("context", f.context);
  if (f.confirmObservation) fd.set("confirmObservation", "on");
  // panorama-event-points Slice 2: persist the incident map pin when set.
  if (f.point) {
    fd.set("locationLat", String(f.point.lat));
    fd.set("locationLng", String(f.point.lng));
    if (f.locationSource) fd.set("locationSource", f.locationSource);
  }
  fd.set("noRedirect", "1");
  return fd;
}
