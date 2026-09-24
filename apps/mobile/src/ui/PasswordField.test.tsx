// PasswordField — the reveal toggle, and the two properties that make it safe.
//
// The web's LnPasswordInput (components/ui/Field.tsx:433) shipped this from
// the start; mobile typed every password blind until the 2026-09-01 QOL pass.
// What is pinned here is not "an eye renders" but the two things a rushed
// refactor would plausibly break: the field STARTS hidden (a password field
// that mounts revealed is a shoulder-surfing gift), and visibility is
// PER-FIELD (revealing "Contraseña" must not reveal "Repetir contraseña" —
// the confirm field exists precisely to catch a typo the person cannot see).

import { describe, expect, it } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { View } from "react-native";

import { PasswordField } from "./kit";

describe("PasswordField", () => {
  it("starts hidden and toggles with an accessible button", () => {
    const { getByLabelText } = render(
      <PasswordField label="Contraseña" onChangeText={() => {}} value="hunter2" />,
    );

    const input = getByLabelText("Contraseña");
    expect(input.props.secureTextEntry).toBe(true);

    fireEvent.press(getByLabelText("Mostrar contraseña"));
    expect(getByLabelText("Contraseña").props.secureTextEntry).toBe(false);

    // The button renames itself to the action it now performs.
    fireEvent.press(getByLabelText("Ocultar contraseña"));
    expect(getByLabelText("Contraseña").props.secureTextEntry).toBe(true);
  });

  it("reveals per FIELD — a sibling stays hidden", () => {
    const { getByLabelText, getAllByLabelText } = render(
      <View>
        <PasswordField label="Contraseña" onChangeText={() => {}} value="hunter2" />
        <PasswordField label="Repetir contraseña" onChangeText={() => {}} value="hunter2" />
      </View>,
    );

    // Two hidden fields → two "Mostrar" buttons; press only the first.
    const [firstToggle] = getAllByLabelText("Mostrar contraseña");
    expect(firstToggle).toBeDefined();
    if (!firstToggle) return;
    fireEvent.press(firstToggle);

    expect(getByLabelText("Contraseña").props.secureTextEntry).toBe(false);
    expect(getByLabelText("Repetir contraseña").props.secureTextEntry).toBe(true);
  });
});
