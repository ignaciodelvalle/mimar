// useDiscardGuard — the four behaviors that make it a guard and not a cage.
//
// (1) dirty → back is intercepted and the person is ASKED; (2) clean → back
// flows, no dialog (a guard on an empty form is a cage); (3) confirming
// "Salir" re-dispatches the ORIGINAL action, so the exit lands wherever the
// gesture was taking them; (4) `allowLeave()` disarms it for the post-submit
// success navigation — blocking one's own `router.replace` would trap the
// person on a form whose pet already exists.

import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { Alert } from "react-native";

import { useDiscardGuard } from "./use-discard-guard";

type Handler = (e: { preventDefault: () => void; data: { action: unknown } }) => void;

function harness(dirty: boolean) {
  let handler: Handler = () => {};
  const navigation = {
    addListener: (_type: "beforeRemove", cb: Handler) => {
      handler = cb;
      return () => {};
    },
    dispatch: jest.fn(),
  };
  let allowLeave: () => void = () => {};
  function Probe() {
    allowLeave = useDiscardGuard(navigation, dirty).allowLeave;
    return null;
  }
  render(<Probe />);
  return {
    navigation,
    fireBack() {
      const e = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
      handler(e);
      return e;
    },
    allowLeave: () => allowLeave(),
  };
}

describe("useDiscardGuard", () => {
  it("intercepts back while dirty and asks before discarding", () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const h = harness(true);

    const e = h.fireBack();
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]?.[0]).toBe("¿Salir del alta?");
    alert.mockRestore();
  });

  it("lets a CLEAN form leave silently — a guard on nothing is a cage", () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const h = harness(false);

    const e = h.fireBack();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it("confirming Salir re-dispatches the ORIGINAL action", () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => {
      const salir = buttons?.find((b) => b.text === "Salir");
      salir?.onPress?.();
    });
    const h = harness(true);

    const e = h.fireBack();
    expect(h.navigation.dispatch).toHaveBeenCalledWith(e.data.action);

    // And the confirmation stands: a SECOND back after confirming flows free
    // (the re-dispatched action itself re-enters beforeRemove).
    const e2 = h.fireBack();
    expect(e2.preventDefault).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it("allowLeave() disarms the guard for the success navigation", () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const h = harness(true);

    h.allowLeave();
    const e = h.fireBack();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });
});
