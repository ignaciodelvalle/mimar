// LnStatusFlag — pet lifecycle status pill (LN skin, tiny mono uppercase).
import { LnStatusFlag } from "dim";

export function Estados() {
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      <LnStatusFlag status="ok" />
      <LnStatusFlag status="registered" />
      <LnStatusFlag status="sick" />
      <LnStatusFlag status="lost" />
      <LnStatusFlag status="pregnant" />
    </div>
  );
}
