import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";

// The auth group had NO layout of its own until 2026-09-09, and that absence is
// the whole reason this file exists.
//
// `DemoModeBanner`'s own header states the guarantee it was built for:
//
//     "Mounted on EVERY shell — public, citizen, and operator — via each
//      AppShell variant's `banner` slot."
//
// True of every shell, and the routes under `(auth)` are not on one. They render
// straight under the ROOT layout, which mounts no banner — so `/iniciar-sesion`,
// `/registro`, `/recuperar` and `/recuperar/actualizar` were the one stretch of
// the product where a person could arrive, read the pitch, and create an account
// without ever being told the data around them is synthetic. Verified against
// the live origin on 2026-09-09: the credential page renders the disclosure,
// `/iniciar-sesion` does not, with `NEXT_PUBLIC_DEMO_MODE` on in both cases.
//
// FOUR ROUTES AND NOT THE SIX IN THIS DIRECTORY, which the first draft of this
// comment claimed. `/login` and `/signup` are `permanentRedirect` stubs that
// render nothing, and `/turno-vencido` is a ROUTE HANDLER (`route.ts`) — layouts
// do not apply to one, so it never rendered under the root layout either and
// was never missing the banner. Counting a directory is not counting a
// surface.
//
// THE FUNNEL IS THE WORST PLACE TO OMIT IT, which is why this is a layout and
// not four edits. Every other public route already discloses; a person who first
// sees the claim exactly where they are deciding to trust the thing is the case
// the disclosure was written for.
//
// A LAYOUT AND NOT AN AppShell. These pages are deliberately chrome-free — a
// login screen with a nav bar invites wandering off mid-flow — so this adds the
// banner and nothing else. `enabled=false` renders null, so in production this
// is one component that returns nothing.
export default function AuthGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DemoModeBanner enabled={shouldShowDemoBanner(process.env.NEXT_PUBLIC_DEMO_MODE)} />
      {children}
    </>
  );
}
