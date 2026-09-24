// The navigation trail (OBS-5) — held to the two things that make it useful
// and not noise: one crumb per screen CHANGE, and no identifier in any of them.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { Text } from "react-native";

type CapturedCrumb = { category?: string; message?: string };
const crumbs: CapturedCrumb[] = [];

jest.mock("@sentry/react-native", () => ({
  captureException: () => undefined,
  addBreadcrumb: (crumb: CapturedCrumb) => {
    crumbs.push(crumb);
  },
}));

import { useNavigationBreadcrumb } from "./use-navigation-breadcrumb";

function Probe({ pathname }: { pathname: string }) {
  useNavigationBreadcrumb(pathname);
  return <Text>{pathname}</Text>;
}

beforeEach(() => {
  crumbs.length = 0;
});

describe("useNavigationBreadcrumb", () => {
  it("records the screen it landed on, with the pet token stripped", () => {
    render(<Probe pathname="/mascotas/DIM-PAMP-0001" />);
    expect(crumbs).toEqual([{ category: "navigation", level: "info", message: "/mascotas/:id" }]);
  });

  it("records one crumb per CHANGE, not one per render", () => {
    // A trail with forty copies of the same screen is a trail nobody reads. The
    // dependency array is the whole mechanism, so it is the thing asserted.
    const view = render(<Probe pathname="/mascotas" />);
    view.rerender(<Probe pathname="/mascotas" />);
    view.rerender(<Probe pathname="/ajustes" />);
    view.rerender(<Probe pathname="/ajustes" />);

    expect(crumbs.map((crumb) => crumb.message)).toEqual(["/mascotas", "/ajustes"]);
  });
});
