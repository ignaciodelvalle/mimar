/**
 * loading.tsx — skeleton for /org/[orgToken]/mordedura/nuevo (new bite report form).
 *
 * `fade={false}` — motion audit §5.2: a report-filing flow must feel instant
 * and mechanical, and the skeleton is the "is this working?" signal. Every
 * other route skeleton fades in (MOT-2); this one deliberately does not.
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgMorderuraNuevoLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[3]} fade={false} />;
}
