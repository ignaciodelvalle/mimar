// Use-case types for signTimelineAttachmentsForPet (strangler migration 43/61).

export type SignTimelineAttachmentsResult = Record<string, string> | { error: string };
