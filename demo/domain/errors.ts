// User-facing errors are shown back to the Discord user verbatim; anything else is
// treated as an operational failure. Mirrors the UserFacingError split in src/.
export class DemoError extends Error {}

export function demoError(message: string): never {
  throw new DemoError(message);
}
