import { scrypt, randomBytes, createHash, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"

const scryptAsync = promisify(scrypt)

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex")
  const hash = (await scryptAsync(password, salt, 64)) as Buffer
  return `${salt}:${hash.toString("hex")}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":")
  if (!salt || !hash) return false
  const derived = (await scryptAsync(password, salt, 64)) as Buffer
  const stored_buf = Buffer.from(hash, "hex")
  if (derived.length !== stored_buf.length) return false
  return timingSafeEqual(derived, stored_buf)
}

export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex")
  const tokenHash = createHash("sha256").update(token).digest("hex")
  return { token, tokenHash }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
