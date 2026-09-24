// TogglePhysicalTagInterestResult for the physical-tag-interest use-case.

export type TogglePhysicalTagInterestResult =
  | { ok: true; state: "interested" | "cancelled" }
  | { error: string };
