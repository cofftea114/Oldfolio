import type { z } from 'zod';

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

const unwrapJsonFence = (value: string): string => {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(value);
  return match?.[1] ?? value;
};

/** Parses model text as JSON and applies a Zod runtime schema. */
export function parseStructuredOutput<T>(raw: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJsonFence(raw)) as unknown;
  } catch (error) {
    throw new StructuredOutputError('The model response is not valid JSON.', error);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StructuredOutputError('The model response does not match the required schema.', result.error);
  }
  return result.data;
}
