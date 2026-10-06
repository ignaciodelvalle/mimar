// The queue form's landing URL, kept out of the "use client" file so it is testable.
// It carries the locality ID, never a label: the page looks the name up itself,
// so the confirmation banner cannot be spoofed with a crafted link.

/** Where the admin lands after resolving: the queue, with the locality for the confirmation. */
export function resolvedPlaceUrl(
  provinceCode: string,
  locality: { localityId: string } | undefined,
): string {
  const params = new URLSearchParams({ provincia: provinceCode });
  if (locality) params.set("resuelto", locality.localityId);
  return `/admin/localidades/pendientes?${params.toString()}`;
}
