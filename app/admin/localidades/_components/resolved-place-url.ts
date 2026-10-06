// The queue form's landing URL, kept out of the "use client" file so it is testable.
/** Where the admin lands after resolving: the queue, carrying the locality for the confirmation. */
export function resolvedPlaceUrl(
  provinceCode: string,
  locality: { name: string; department: string | null } | undefined,
): string {
  const params = new URLSearchParams({ provincia: provinceCode });
  if (locality) {
    params.set(
      "resuelto",
      locality.department ? `${locality.name} (${locality.department})` : locality.name,
    );
  }
  return `/admin/localidades/pendientes?${params.toString()}`;
}
