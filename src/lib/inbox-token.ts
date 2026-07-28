import { SignJWT } from "jose"

// Firma el token de staff (server-to-server con la ai-api). `role` es el rol del usuario del
// CRM que originó la request; la ai-api lo usa para proteger mutaciones sensibles (ej. topes
// de uso, solo superadmin). Opcional: las operaciones de inbox comunes no lo necesitan.
export async function mintInboxToken(aiTenantId: string, role?: string): Promise<string> {
  const secret = process.env.STAFF_TOKEN_SECRET
  if (!secret) throw new Error("STAFF_TOKEN_SECRET no configurado")
  return new SignJWT({ tenantId: aiTenantId, scope: "staff", ...(role ? { role } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret))
}
