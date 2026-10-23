/** A failed openDesk request; `status` is 0 when the server could not be reached. */
export class OpenDeskError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpenDeskError';
  }

  /** The visitor token is unknown or revoked; a fresh session is needed. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}
