import {
  OLDFOLIO_PROFILE_TYPES,
  type OkfConceptFrontmatter,
  type OkfIndexFrontmatter,
  type OldfolioProfileType,
} from '@oldfolio/domain';
import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/, 'Expected an ISO date (YYYY-MM-DD)');
const isoDateTimeSchema = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)),
  'Expected an ISO-8601 datetime',
);

export const okfUsageWindowSchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
  })
  .catchall(z.unknown());

export const okfSourceSchema = z
  .object({
    resource: nonEmptyStringSchema,
    id: nonEmptyStringSchema.optional(),
    title: z.string().optional(),
    author: nonEmptyStringSchema.optional(),
    usage_count: z.number().nonnegative().optional(),
    last_modified: isoDateSchema.optional(),
    usage_window: okfUsageWindowSchema.optional(),
  })
  .catchall(z.unknown());

export const okfGeneratedSchema = z
  .object({
    by: nonEmptyStringSchema,
    at: isoDateTimeSchema.optional(),
  })
  .catchall(z.unknown());

export const okfVerificationSchema = z
  .object({
    by: nonEmptyStringSchema,
    at: isoDateTimeSchema,
  })
  .catchall(z.unknown());

const normalizedVerifiedSchema = z
  .union([okfVerificationSchema, z.array(okfVerificationSchema)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

export const okfParameterSchema = z
  .object({
    name: nonEmptyStringSchema,
    type: nonEmptyStringSchema,
    required: z.boolean(),
  })
  .catchall(z.unknown());

export const okfExecutorSchema = z
  .object({
    resource: nonEmptyStringSchema,
    receipt: z.array(nonEmptyStringSchema).optional(),
  })
  .catchall(z.unknown());

export const okfAttesterSchema = z
  .object({
    resource: nonEmptyStringSchema,
  })
  .catchall(z.unknown());

export const oldfolioMetadataSchema = z
  .object({
    id: nonEmptyStringSchema,
  })
  .catchall(z.unknown());

const okfConceptObjectSchema = z
  .object({
    type: nonEmptyStringSchema,
    title: z.string().optional(),
    description: z.string().optional(),
    resource: nonEmptyStringSchema.optional(),
    tags: z.array(nonEmptyStringSchema).optional(),
    sources: z.array(okfSourceSchema).optional(),
    usage_window: okfUsageWindowSchema.optional(),
    generated: okfGeneratedSchema.optional(),
    verified: normalizedVerifiedSchema.optional(),
    status: z.enum(['draft', 'stable', 'deprecated']).optional(),
    stale_after: isoDateSchema.optional(),
    runtime: nonEmptyStringSchema.optional(),
    parameters: z.array(okfParameterSchema).optional(),
    computation: nonEmptyStringSchema.optional(),
    executor: okfExecutorSchema.optional(),
    attester: okfAttesterSchema.optional(),
    oldfolio: oldfolioMetadataSchema.optional(),
  })
  .catchall(z.unknown());

/** OKF v0.2 frontmatter, including validation for optional standardized families. */
export const okfConceptFrontmatterSchema = okfConceptObjectSchema.superRefine((value, context) => {
  if (value.type === 'Attested Computation' && value.runtime === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['runtime'],
      message: '`runtime` is required for an Attested Computation',
    });
  }

  if (isOldfolioProfileType(value.type) && value.oldfolio === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['oldfolio', 'id'],
      message: '`oldfolio.id` is required for Oldfolio profile concepts',
    });
  }
}) satisfies z.ZodType<OkfConceptFrontmatter>;

export const okfIndexFrontmatterSchema = z
  .object({
    okf_version: nonEmptyStringSchema,
  })
  .catchall(z.unknown()) satisfies z.ZodType<OkfIndexFrontmatter>;

function createProfileSchema(type: OldfolioProfileType) {
  return okfConceptObjectSchema
    .extend({
      type: z.literal(type),
      oldfolio: oldfolioMetadataSchema,
    });
}

export const oldfolioSourceConceptSchema = createProfileSchema('Source');
export const oldfolioTranscriptConceptSchema = createProfileSchema('Transcript');
export const oldfolioConceptSchema = createProfileSchema('Concept');
export const oldfolioCreatorConceptSchema = createProfileSchema('Creator');
export const oldfolioPerspectiveConceptSchema = createProfileSchema('Perspective');
export const oldfolioAudienceInsightConceptSchema = createProfileSchema('Audience Insight');
export const oldfolioSynthesisConceptSchema = createProfileSchema('Synthesis');

export const oldfolioProfileSchemas = {
  Source: oldfolioSourceConceptSchema,
  Transcript: oldfolioTranscriptConceptSchema,
  Concept: oldfolioConceptSchema,
  Creator: oldfolioCreatorConceptSchema,
  Perspective: oldfolioPerspectiveConceptSchema,
  'Audience Insight': oldfolioAudienceInsightConceptSchema,
  Synthesis: oldfolioSynthesisConceptSchema,
} as const;

export function isOldfolioProfileType(value: string): value is OldfolioProfileType {
  return (OLDFOLIO_PROFILE_TYPES as readonly string[]).includes(value);
}
