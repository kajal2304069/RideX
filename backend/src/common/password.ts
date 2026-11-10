import argon2 from "argon2";

/**
 * Argon2id (the hybrid variant) is used over bcrypt because it's the
 * current OWASP-recommended default: resistant to both GPU-cracking
 * (memory-hard) and side-channel attacks (unlike argon2i alone).
 * Parameters below follow OWASP's minimum recommended baseline.
 */
const HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // ~19 MB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Malformed hash, etc. - treat as "does not match" rather than throwing,
    // so a corrupted hash can't be used to distinguish error states.
    return false;
  }
}
