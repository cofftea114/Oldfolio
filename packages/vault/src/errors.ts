export class VaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UnsafeVaultPathError extends VaultError {}

export class VaultSymlinkError extends UnsafeVaultPathError {}

export class VaultConflictError extends VaultError {
  constructor(
    readonly path: string,
    readonly expectedRevision: string | null,
    readonly actualRevision: string | null,
  ) {
    super(
      `Revision conflict for ${path}: expected ${expectedRevision ?? '<missing>'}, got ${actualRevision ?? '<missing>'}`,
    );
  }
}

export class VaultNotFoundError extends VaultError {
  constructor(readonly path: string) {
    super(`Vault path does not exist: ${path}`);
  }
}

export class VaultHistoryError extends VaultError {}
