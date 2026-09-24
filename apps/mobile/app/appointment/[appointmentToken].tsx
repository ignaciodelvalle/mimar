// `mimar://appointment/{token}` — where the check-in QR lands when a phone
// follows it. THE ACTUAL SCREEN IS `AppointmentCheckInFallbackScreen`
// (`src/turnos/`); this file only satisfies the route shape
// `DEEP_LINK_MAP.appointment.appPath` claims — the same split every other
// route in `app/` follows (`app/turnos/[appointmentToken].tsx` +
// `TurnoDetailScreen`), which is what makes the screen testable under jest
// (`roots: ["<rootDir>/src"]` in `jest.config.js` — nothing under `app/` runs).
//
// THE TOKEN IS DELIBERATELY UNUSED. See the screen's own header for why: no
// session, no lookup, and the token itself is never read back out of the url,
// only matched by expo-router to land here.

export { AppointmentCheckInFallbackScreen as default } from "../../src/turnos/AppointmentCheckInFallbackScreen";
