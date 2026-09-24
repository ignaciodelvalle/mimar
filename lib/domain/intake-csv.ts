// Intake CSV domain — single source of truth for the bulk-intake template AND
// parser (org-pilot-pack Req 1, design D1/D6). The template route generates
// the file from this catalog and the validate action maps uploads back through
// it, so the two can never drift.
//
// Encoding reality check (spec 1.8 — REQUIRED, not deferred): the org admin's
// actual export path is Excel with Argentina regional settings, which produces
// semicolon-delimited files in Windows-1252 (older Excel) or UTF-8 with BOM
// (newer Excel). We therefore:
//   - strip a UTF-8 BOM,
//   - decode strict UTF-8 first and fall back to windows-1252 on failure,
//   - sniff `;` vs `,` on the header row.
//
// Per-row validation is NOT done here — the validate action builds synthetic
// FormData from the mapped fields and runs the REAL `parseIntakeForm` (the
// exact write-time rules). This module only handles the es-AR ↔ FormData
// translation layer and rejects what the translation itself can see
// (unknown enum values, malformed dates).

// ---------------------------------------------------------------------------
// Caps (design D6)
// ---------------------------------------------------------------------------

export const INTAKE_CSV_MAX_ROWS = 200;
export const INTAKE_CSV_MAX_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Column catalog
// ---------------------------------------------------------------------------

export type IntakeCsvColumn = {
  /** es-AR header as it appears in the template (asterisk marks required). */
  header: string;
  /** Normalized header key (lowercase, no asterisk) used for matching. */
  key: string;
  /** English intake FormData field this column feeds. */
  field: string;
  required: boolean;
  /** Example-row value for the template. */
  example: string;
};

function col(header: string, field: string, required: boolean, example: string): IntakeCsvColumn {
  return { header, key: header.replace(/\*$/, ""), field, required, example };
}

/**
 * Template order follows the form's mental model (identity → identifiers →
 * intake state → date). `custodyRole` is intentionally NOT a column — bulk
 * imports always default to `shelter_custody` (design D6); sanctuary-style
 * `owner` intakes go through the individual form.
 */
export const INTAKE_CSV_COLUMNS: readonly IntakeCsvColumn[] = [
  col("nombre*", "name", true, "Negrita"),
  col("especie*", "species", true, "perro"),
  col("sexo", "sex", false, "hembra"),
  col("edad_anios", "ageYears", false, "2"),
  col("edad_meses", "ageMonths", false, "6"),
  col("raza", "breed", false, "mestizo"),
  col("color", "color", false, "negro"),
  col("peso_estimado_kg", "estimatedWeightKg", false, "12,5"),
  col("senias_particulares", "distinguishingFeatures", false, "mancha blanca en el pecho"),
  col("microchip", "microchipId", false, ""),
  col("pais_chip", "microchipCountryCode", false, ""),
  col("tatuaje", "tattooCode", false, ""),
  col("motivo_ingreso*", "intakeReason", true, "rescate"),
  col("condicion_ingreso", "intakeCondition", false, "buen estado general"),
  col("jurisdiccion_rescate", "rescueJurisdiction", false, "La Plata, Buenos Aires"),
  col("fecha_ingreso*", "occurredAt", true, "01/07/2026"),
];

// ---------------------------------------------------------------------------
// es-AR enum values → intake enum values
// ---------------------------------------------------------------------------

const SPECIES_MAP: Record<string, string> = {
  perro: "dog",
  gato: "cat",
  otra: "other",
};

const SEX_MAP: Record<string, string> = {
  macho: "male",
  hembra: "female",
  desconocido: "unknown",
};

const INTAKE_REASON_MAP: Record<string, string> = {
  rescate: "rescue",
  entrega: "surrender",
  via_publica: "stray_found",
  otro: "other",
};

// ---------------------------------------------------------------------------
// Decoding + delimiter sniff
// ---------------------------------------------------------------------------

/**
 * Decodes raw CSV bytes: BOM-stripped strict UTF-8 first, windows-1252 (Excel
 * es-AR) as the fallback. Never throws for the fallback path — windows-1252
 * maps every byte.
 */
export function decodeIntakeCsv(bytes: Uint8Array): {
  text: string;
  encoding: "utf-8" | "windows-1252";
} {
  // Strip UTF-8 BOM bytes up front so both decoders see clean input.
  const body =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    // Defensive: a BOM that survived (e.g. double-BOM) decodes to U+FEFF.
    return { text: text.replace(/^﻿/, ""), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(body), encoding: "windows-1252" };
  }
}

/**
 * Sniffs `;` vs `,` on the header row (design D1). Excel es-AR exports `;`;
 * a hand-made file may use `,`. Ties and zero-counts default to `;` — the
 * template's own delimiter.
 */
export function sniffIntakeCsvDelimiter(text: string): ";" | "," {
  const headerLine = text.split(/\r?\n/, 1)[0] ?? "";
  const semis = (headerLine.match(/;/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  return commas > semis ? "," : ";";
}

// ---------------------------------------------------------------------------
// Template builder (design D6: BOM + `;` + CRLF + one example row)
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (/[";,\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Builds the downloadable template: UTF-8 BOM (so Excel es-AR opens it with
 * accents intact), semicolon delimiter, CRLF line endings, es-AR headers and
 * one illustrative example row.
 */
export function buildIntakeCsvTemplate(): string {
  const header = INTAKE_CSV_COLUMNS.map((c) => csvEscape(c.header)).join(";");
  const example = INTAKE_CSV_COLUMNS.map((c) => csvEscape(c.example)).join(";");
  return `﻿${header}\r\n${example}\r\n`;
}

export const INTAKE_CSV_TEMPLATE_FILENAME = "plantilla-ingreso.csv";

// ---------------------------------------------------------------------------
// Export half — the roster download (org-first readiness finding #4)
// ---------------------------------------------------------------------------
//
// A shelter must be able to take its own roster with it. The export is built
// from the SAME column catalog and the SAME delimiter/BOM/CRLF rules as the
// template above, so a downloaded roster re-uploads through the import path
// without a single edit — that round-trip is the whole point of an exit ramp,
// and it is only free because import and export share this module.
//
// The enum translations are the INVERSE of the import maps, derived from them
// programmatically: hand-written reverse tables are exactly the kind of thing
// that drifts the day someone adds a species to one side only.

/** Extra, EXPORT-ONLY column. Header-keyed mapping ignores it on re-upload. */
export const INTAKE_CSV_EXPORT_STATUS_HEADER = "estado";

function invert(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([es, en]) => [en, es]));
}

const SPECIES_MAP_REVERSE = invert(SPECIES_MAP);
const SEX_MAP_REVERSE = invert(SEX_MAP);
const INTAKE_REASON_MAP_REVERSE = invert(INTAKE_REASON_MAP);

/**
 * Stored enum → the es-AR word the import understands.
 *
 * An UNMAPPED value (species "ferret", "rabbit"… — real pet species the bulk
 * template never offered) is emitted RAW, not folded into "otra". Folding would
 * silently rewrite the animal's species on re-import; the raw value re-imports
 * as a named per-column error the operator can see and decide about. An export
 * that quietly loses a fact is worse than one that asks a question.
 */
export function speciesToIntakeCsvValue(species: string): string {
  return SPECIES_MAP_REVERSE[species] ?? species;
}

export function sexToIntakeCsvValue(sex: string): string {
  return SEX_MAP_REVERSE[sex] ?? sex;
}

export function intakeReasonToIntakeCsvValue(reason: string | null | undefined): string {
  if (!reason) return "";
  return INTAKE_REASON_MAP_REVERSE[reason] ?? reason;
}

/**
 * Numeric weight (Postgres numeric arrives as "12.50") → the decimal-comma form
 * Excel es-AR and `mapIntakeCsvRecord` both expect ("12,5"). Trailing zeros are
 * dropped so the operator sees the number they typed, not the column's scale.
 * Returns "" for null/unparseable rather than printing "NaN" into a cell.
 */
export function weightToIntakeCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const n = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(n)) return "";
  return String(n).replace(".", ",");
}

/**
 * Builds the roster export: template layout (same headers in the same order,
 * BOM, `;`, CRLF) plus the trailing export-only `estado` column.
 *
 * Each record is keyed by the catalog's normalized `key` (e.g. "nombre", not
 * "nombre*") — the same key `mapIntakeCsvRecord` matches on — so callers never
 * hand-write a header string.
 */
export function buildIntakeExportCsv(records: Record<string, string>[]): string {
  const header = [
    ...INTAKE_CSV_COLUMNS.map((c) => csvEscape(c.header)),
    INTAKE_CSV_EXPORT_STATUS_HEADER,
  ].join(";");
  const lines = records.map((record) => {
    const cells = INTAKE_CSV_COLUMNS.map((c) => csvEscape(record[c.key] ?? ""));
    cells.push(csvEscape(record[INTAKE_CSV_EXPORT_STATUS_HEADER] ?? ""));
    return cells.join(";");
  });
  return `﻿${header}\r\n${lines.join("\r\n")}${lines.length ? "\r\n" : ""}`;
}

// ---------------------------------------------------------------------------
// Record mapping (es-AR record → intake FormData fields)
// ---------------------------------------------------------------------------

/** Normalizes an uploaded header for catalog matching. */
function normalizeHeader(raw: string): string {
  return raw.replace(/^﻿/, "").trim().toLowerCase().replace(/\*$/, "");
}

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * `DD/MM/AAAA` → ISO `YYYY-MM-DD`, rejecting impossible dates (31/02/…).
 * Returns null when malformed.
 */
export function normalizeIntakeCsvDate(raw: string): string | null {
  const m = DATE_RE.exec(raw.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number.parseInt(dd, 10);
  const month = Number.parseInt(mm, 10);
  const year = Number.parseInt(yyyy, 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${yyyy}-${mm}-${dd}`;
}

export type IntakeCsvMappedRow = {
  /** English FormData fields ready for parseIntakeForm (only set when clean). */
  fields: Record<string, string>;
  /** es-AR errors naming the column and the reason (spec 1.3). */
  errors: string[];
};

function enumError(column: string, value: string, options: string[]): string {
  return `${column}: valor inválido «${value}» (opciones: ${options.join(", ")})`;
}

// The three enum-mapped fields share one shape (lowercase lookup → mapped value
// or a named per-column error) — table-driven so mapIntakeCsvRecord's switch
// stays within the cognitive-complexity budget.
const ENUM_FIELD_MAPS: Partial<Record<string, Record<string, string>>> = {
  species: SPECIES_MAP,
  sex: SEX_MAP,
  intakeReason: INTAKE_REASON_MAP,
};

/**
 * Maps one parsed CSV record (keyed by the file's own headers) to intake
 * FormData fields. Translation-layer errors (unknown enum values, malformed
 * dates) are named per column; deeper validation happens in parseIntakeForm.
 */
export function mapIntakeCsvRecord(record: Record<string, string>): IntakeCsvMappedRow {
  // Re-key by normalized header so "nombre*", "Nombre" and "nombre" all land.
  const byKey = new Map<string, string>();
  for (const [rawHeader, value] of Object.entries(record)) {
    byKey.set(normalizeHeader(rawHeader), typeof value === "string" ? value.trim() : "");
  }

  const fields: Record<string, string> = { custodyRole: "shelter_custody" };
  const errors: string[] = [];

  for (const column of INTAKE_CSV_COLUMNS) {
    const raw = byKey.get(column.key) ?? "";
    if (!raw) {
      if (column.required) errors.push(`${column.key}: falta el valor (columna obligatoria)`);
      continue;
    }

    const enumMap = ENUM_FIELD_MAPS[column.field];
    if (enumMap) {
      const mapped = enumMap[raw.toLowerCase()];
      if (mapped) fields[column.field] = mapped;
      else errors.push(enumError(column.key, raw, Object.keys(enumMap)));
      continue;
    }

    switch (column.field) {
      case "occurredAt": {
        const iso = normalizeIntakeCsvDate(raw);
        if (!iso) {
          errors.push(`${column.key}: fecha inválida «${raw}» (formato DD/MM/AAAA)`);
          break;
        }
        fields.occurredAt = iso;
        break;
      }
      case "estimatedWeightKg": {
        // Excel es-AR writes decimal commas ("12,5") — normalize to a dot so
        // the numeric parse downstream sees a standard decimal.
        fields.estimatedWeightKg = /^\d+,\d+$/.test(raw) ? raw.replace(",", ".") : raw;
        break;
      }
      default: {
        fields[column.field] = raw;
      }
    }
  }

  return { fields, errors };
}

// ---------------------------------------------------------------------------
// Duplicate flagging (spec 1.10 — warn, never dedupe or block)
// ---------------------------------------------------------------------------

/**
 * Returns the 0-based indexes of records that are EXACT full-row duplicates of
 * an earlier record. Littermates entered as near-identical rows are legitimate
 * (events append-only — no assumption of user error), so this only flags
 * byte-identical rows, and only as a warning for the operator to consciously
 * confirm or prune.
 */
export function findExactDuplicateRows(records: Record<string, string>[]): Set<number> {
  const seen = new Map<string, number>();
  const duplicates = new Set<number>();
  records.forEach((record, index) => {
    const signature = JSON.stringify(
      Object.entries(record)
        .map(([k, v]) => [normalizeHeader(k), (v ?? "").trim()])
        .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    );
    const first = seen.get(signature);
    if (first !== undefined) {
      duplicates.add(index);
    } else {
      seen.set(signature, index);
    }
  });
  return duplicates;
}

// ---------------------------------------------------------------------------
// Failed-rows CSV (spec 1.6 — same template layout + error column)
// ---------------------------------------------------------------------------

/**
 * Builds the re-downloadable failed-rows CSV: template layout (same headers,
 * BOM, `;`, CRLF), original values preserved, plus a trailing `errores`
 * column — fix and re-upload without retyping the successful rows. The extra
 * column is ignored on re-upload (mapping is header-keyed).
 */
export function buildFailedRowsCsv(
  rows: { record: Record<string, string>; errors: string[] }[],
): string {
  const header = [...INTAKE_CSV_COLUMNS.map((c) => csvEscape(c.header)), "errores"].join(";");
  const lines = rows.map(({ record, errors }) => {
    const byKey = new Map<string, string>();
    for (const [rawHeader, value] of Object.entries(record)) {
      byKey.set(normalizeHeader(rawHeader), value ?? "");
    }
    const cells = INTAKE_CSV_COLUMNS.map((c) => csvEscape(byKey.get(c.key) ?? ""));
    cells.push(csvEscape(errors.join(" | ")));
    return cells.join(";");
  });
  return `﻿${header}\r\n${lines.join("\r\n")}${lines.length ? "\r\n" : ""}`;
}
