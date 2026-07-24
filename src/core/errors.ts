/** An error whose message is safe to show back to the person who triggered it. */
export class UserFacingError extends Error {}

export function userError(message: string): never {
  throw new UserFacingError(message);
}

export function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
