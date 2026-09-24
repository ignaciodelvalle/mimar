// Pure helpers for the Vaul-based Sheet component — extracted for unit testing.

export type SheetSize = "sm" | "md" | "lg";

/**
 * Extracts the active sheet id from a URLSearchParams-like object,
 * or returns null if no `sheet` param is present.
 */
export function getSheetIdFromSearchParams(
  searchParams: URLSearchParams | Record<string, string>,
): string | null {
  const raw =
    searchParams instanceof URLSearchParams
      ? searchParams.get("sheet")
      : (searchParams.sheet ?? null);
  return raw && raw.length > 0 ? raw : null;
}

/**
 * Returns a URL string with `?sheet=<sheetId>` set, preserving all other params.
 *
 * `pathname` is REQUIRED, and that is the whole point. A bare query href —
 * `<Link href="?sheet=contactar">` — renders, focuses, and does nothing: the
 * click never navigates, so the sheet never opens. It is a silent dead end,
 * indistinguishable from a working button until someone presses it.
 *
 * Ten triggers were written that way and all ten were dead: four on /cuenta
 * (declarar DNI, editar perfil, solicitar rol vet, renunciar al rol) and six on
 * the public shelter page — including "Contactar al refugio" and "Sumate como
 * voluntario", two conversion paths on a page shown to strangers. The master
 * test CIU (2026-08-10, N2b) found ONE of them and reported it as a lone dead
 * button; the pattern was the bug.
 *
 * Always give the sheet URL an explicit pathname — via this helper, or as a
 * literal like `/cuenta?sheet=editar-perfil`.
 */
export function buildSheetUrl(
  pathname: string,
  currentSearchParams: URLSearchParams | Record<string, string>,
  sheetId: string,
): string {
  const params =
    currentSearchParams instanceof URLSearchParams
      ? new URLSearchParams(currentSearchParams.toString())
      : new URLSearchParams(currentSearchParams);
  params.set("sheet", sheetId);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Returns a URL string with the `sheet` param removed, preserving all other params.
 */
export function buildCloseSheetUrl(
  pathname: string,
  currentSearchParams: URLSearchParams | Record<string, string>,
): string {
  const params =
    currentSearchParams instanceof URLSearchParams
      ? new URLSearchParams(currentSearchParams.toString())
      : new URLSearchParams(currentSearchParams);
  params.delete("sheet");
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Returns a Tailwind width class for the right-drawer based on the given size.
 */
export function getDrawerWidth(size: SheetSize): string {
  switch (size) {
    case "sm":
      return "md:w-[320px]";
    case "md":
      return "md:w-[480px]";
    case "lg":
      return "md:w-[640px]";
  }
}
