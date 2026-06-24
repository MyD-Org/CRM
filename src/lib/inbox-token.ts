import { SignJWT } from "jose"

export async function mintInboxToken(aiTenantId: string): Promise<string> {
  const secret = process.env.STAFF_TOKEN_SECRET
  if (!secret) throw new Error("STAFF_TOKEN_SECRET no configurado")
  return new SignJWT({ tenantId: aiTenantId, scope: "staff" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret))
}
