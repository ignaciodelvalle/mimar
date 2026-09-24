// /gob/vigilancia/zoonosis — retired (near-duplicate of the parent
// /gob/vigilancia panels, which already render the disease summary table and
// zoonosis trend chart). Kept as a thin redirect so any deep link (bookmark,
// e2e spec, external reference) still resolves instead of 404ing.
//
// The underlying DiseaseSummaryTable / trend fetchers this page used
// (fetchDiseaseSummary, fetchZoonosisTrend) are NOT deleted — the parent
// /gob/vigilancia page still uses them directly.

import { redirect } from "next/navigation";

export default function GobVigilanciaZoonosisPage(): never {
  redirect("/gob/vigilancia");
}
