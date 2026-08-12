/** An ISO-8601 calendar date (`YYYY-MM-DD`). */
export type ISODate = string;

/** An ISO-8601 timestamp including a UTC offset. */
export type ISODateTime = string;

/** A lower-case hexadecimal digest. The hashing algorithm is supplied by context. */
export type ContentHash = string;

/** A path relative to a vault root, always using `/` separators. */
export type VaultPath = string;

export interface OperationContext {
  readonly signal?: AbortSignal;
  readonly requestId?: string;
}

/** JSON Schema represented without binding the domain package to a validator. */
export type JsonSchema = Readonly<Record<string, unknown>>;
