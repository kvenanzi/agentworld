const KEY_PREFIX = "tw_";
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Generate a new API key. Shown to the agent exactly once at registration. */
export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return KEY_PREFIX + s;
}

/** Keys are stored only as SHA-256 hex digests. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function looksLikeApiKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX) && key.length > 20 && key.length < 100;
}
