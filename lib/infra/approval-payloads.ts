// Zod schemas for approval_requests.payload, one per request type.
//
// Same shape and discipline as lib/event-schemas.ts: each schema is strict
// (extra keys throw) so applicant-side drift is caught at the insert site.
// validateApprovalPayload is called from every approval-request writer.
//
// `service_provider_scheduling` is deferred to Fase 8 (service_providers
// table does not exist yet). When that lands, register its schema here.

import { z } from "zod";

import { APPROVAL_REQUEST_TYPES, type ApprovalRequestType } from "@/db/schema";

// Helper used by every payload to declare its version for future upcasting,
// mirroring the pet_events approach.
const withVersion = <T extends z.ZodRawShape>(shape: T) => ({
  payload_version: z.literal(1).default(1),
  ...shape,
});

// role_upgrade_vet — applicant submits matricula + jurisdiction + optional
// specialty / years of experience. Evidence attachments (matricula scan,
// DNI scan) hang off the approval_request via attachments.approval_request_id.
const roleUpgradeVet = z
  .object(
    withVersion({
      matricula_number: z.string().min(3).max(30),
      matricula_jurisdiccion: z.string().min(2).max(60),
      especialidad: z.string().max(100).nullable().default(null),
      anos_experiencia: z.number().int().min(0).max(80).nullable().default(null),
    }),
  )
  .strict();

// organization_verification — accompanies a brand-new organizations row.
// org_type echoes organizations.org_type for fast routing at review time.
const organizationVerification = z
  .object(
    withVersion({
      org_type: z.enum(["clinic", "shelter", "rescue_network", "sanitary_authority", "other"]),
      cuit: z
        .string()
        .regex(/^\d{11}$/)
        .nullable()
        .default(null),
      personeria_juridica_number: z.string().max(60).nullable().default(null),
      additional_documents_summary: z.string().max(1000).nullable().default(null),
    }),
  )
  .strict();

// Registry mirrors lib/event-schemas.ts. Partial<Record<...>> in case a new
// type is added to the enum before its schema lands — validateApprovalPayload
// throws a clear error rather than silently accepting.
export const APPROVAL_PAYLOAD_SCHEMAS: Partial<Record<ApprovalRequestType, z.ZodTypeAny>> = {
  role_upgrade_vet: roleUpgradeVet,
  organization_verification: organizationVerification,
};

export class ApprovalPayloadValidationError extends Error {
  readonly type: ApprovalRequestType;
  readonly zodError: z.ZodError | undefined;
  constructor(message: string, type: ApprovalRequestType, zodError?: z.ZodError) {
    super(message);
    this.name = "ApprovalPayloadValidationError";
    this.type = type;
    this.zodError = zodError;
  }
}

// Validate a payload against the schema for its type. Throws on failure;
// returns the parsed payload (with defaults filled in) on success. Use the
// returned value when inserting — it carries payload_version: 1.
export function validateApprovalPayload(type: ApprovalRequestType, payload: unknown): unknown {
  const schema = APPROVAL_PAYLOAD_SCHEMAS[type];
  if (!schema) {
    throw new ApprovalPayloadValidationError(
      `No Zod schema registered for approval type "${type}". Add it to lib/approval-payloads.ts before writing this request.`,
      type,
    );
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ApprovalPayloadValidationError(
      `Invalid payload for ${type}: ${result.error.message}`,
      type,
      result.error,
    );
  }
  return result.data;
}

// Useful for coverage assertions / debugging — ensures every type in
// APPROVAL_REQUEST_TYPES has a registered schema (or is intentionally
// unimplemented).
export const IMPLEMENTED_APPROVAL_TYPES: ReadonlyArray<ApprovalRequestType> = Object.keys(
  APPROVAL_PAYLOAD_SCHEMAS,
) as ApprovalRequestType[];

// Re-export for tests.
export { APPROVAL_REQUEST_TYPES };
