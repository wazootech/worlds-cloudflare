/**
 * validateWorldId rejects a caller-provided worldId that is not a non-empty
 * string. Every scoping branch in the adapter is truthiness-based
 * (`worldId ? scoped : unscoped`), so an empty-string worldId would silently
 * disable world scoping and run SQL over a shared database instead of failing
 * visibly (worlds-cloudflare#71).
 */
export function validateWorldId(
  worldId: string | undefined,
  context: string,
): void {
  if (worldId === undefined) return;
  if (typeof worldId !== "string" || worldId.trim() === "") {
    throw new Error(
      `${context}: worldId, when provided, must be a non-empty string; ` +
        `an empty value would silently disable world scoping`,
    );
  }
}
