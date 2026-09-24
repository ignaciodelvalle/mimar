// `/ingreso` — email and password.
//
// A thin route (F-5, 2026-09-24 review): `IngresoScreen` carries the whole
// screen so it can be render-tested — `app/` sits outside jest's `roots`
// (`jest.config.js` anchors it at `<rootDir>/src`, and says why).

import { IngresoScreen } from "../src/auth/IngresoScreen";

export default function IngresoRoute() {
  return <IngresoScreen />;
}
