// LnPetPhoto — pet avatar with status ring and diagonal placeholder.
import { LnPetPhoto } from "dim";

export function Variantes() {
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      <LnPetPhoto alt="Firulais" size={56} status="ok" />
      <LnPetPhoto alt="Michi" size={56} status="lost" />
      <LnPetPhoto alt="Rocco" size={72} radius="md" />
      <LnPetPhoto alt="Atún" size={40} />
    </div>
  );
}
