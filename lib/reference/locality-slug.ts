// The folding the catalogue's `locality_slug` column is built with
// (scripts/import-indec-localities.ts `slugify`, minus its ingest-time
// sanitising): accents and case folded, dots dropped, every other run of
// non-alphanumerics one hyphen. Pure — shared by the alias generator and the
// alias search so both compare names exactly the way the catalogue does.
export function localitySlug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
