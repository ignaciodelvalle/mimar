// Validity check WITHOUT side effects, for programmatic (non-user) gates.
//
// `form.checkValidity()` fires an `invalid` event on every failing control.
// That used to be harmless, until the shared LN controls started reacting to
// `invalid` (es-AR bubble localization, and — 2026-08-18 — scrolling the
// first invalid control into view so a long form's rejection is visible).
// The notification quick-reply autoconfirm effects call their gate in a MOUNT
// effect; with checkValidity() the page jumped the viewport to the first
// empty required field on load, with no user action. This reads the same
// native ValidityState the browser maintains, silently.
export function formIsSilentlyValid(form: HTMLFormElement): boolean {
  return Array.from(form.elements).every((el) => {
    const control = el as HTMLInputElement;
    // Controls outside constraint validation (fieldset, disabled, buttons
    // with no constraints) report willValidate=false and must not veto.
    return !control.willValidate || control.validity.valid;
  });
}
