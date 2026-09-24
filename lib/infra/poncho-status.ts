import type { Pet } from "@/db";

/** Map DB pet.status (3 values) to Poncho Photo status (4 values).
 *  "found" is presentation-only and only set explicitly by callers — never derived from DB. */
export function petStatusToPhotoStatus(status: Pet["status"]): "ok" | "lost" | "deceased" {
  if (status === "lost") return "lost";
  if (status === "deceased") return "deceased";
  return "ok";
}
