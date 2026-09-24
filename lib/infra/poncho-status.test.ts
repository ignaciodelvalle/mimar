import { petStatusToPhotoStatus } from "@/lib/infra/poncho-status";
import { describe, expect, it } from "vitest";

describe("petStatusToPhotoStatus", () => {
  it("active → ok", () => {
    expect(petStatusToPhotoStatus("active")).toBe("ok");
  });

  it("lost → lost", () => {
    expect(petStatusToPhotoStatus("lost")).toBe("lost");
  });

  it("deceased → deceased", () => {
    expect(petStatusToPhotoStatus("deceased")).toBe("deceased");
  });
});
