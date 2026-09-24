import { describe, expect, it } from "vitest";

import { checkboxOn } from "./form-checkbox";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

describe("checkboxOn", () => {
  it('accepts the browser default "on" (bare checkbox)', () => {
    expect(checkboxOn(fd({ agree: "on" }), "agree")).toBe(true);
  });

  it('accepts "true" (checkbox with value="true") — the regression that broke the bite/death forms', () => {
    expect(checkboxOn(fd({ agree: "true" }), "agree")).toBe(true);
  });

  it("treats an absent field (unchecked checkbox) as false", () => {
    expect(checkboxOn(fd({}), "agree")).toBe(false);
  });

  it('treats an explicit "false" as unchecked', () => {
    expect(checkboxOn(fd({ agree: "false" }), "agree")).toBe(false);
  });

  it("treats any other value as unchecked", () => {
    expect(checkboxOn(fd({ agree: "yes" }), "agree")).toBe(false);
  });
});
