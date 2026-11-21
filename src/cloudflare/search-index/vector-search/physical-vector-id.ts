/**
 * physicalVectorId namespaces a contract search-result id by world. Vectorize
 * caps ids at 64 bytes, so the pair is hashed (SHA-256, base64url: 45
 * characters with the prefix) instead of concatenated.
 *
 * Exported so consumers (worlds-api#86) can compute the same physical id
 * without mirroring the hash scheme.
 */
export async function physicalVectorId(
  worldId: string,
  resultId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${worldId}\u0000${resultId}`),
  );
  return `v.${base64Url(new Uint8Array(digest))}`;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}
