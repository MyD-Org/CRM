import { timingSafeEqual } from "crypto"

// Comparación de strings en tiempo constante, para secretos compartidos
// (INTERNAL_SECRET, CRON_SECRET, etc.). Evita el early-return de `!==`/`===`,
// que filtra información de timing sobre cuántos caracteres coinciden.
//
// `timingSafeEqual` exige buffers del mismo largo; si difieren, corta antes
// (el largo de un secreto no es sensible). Compara sobre bytes UTF-8.
export function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// Helper para el patrón `Authorization: Bearer <secret>`. Devuelve true solo si
// el header trae exactamente el secreto esperado (y el secreto está configurado).
export function bearerMatches(authHeader: string | null, expectedSecret: string | undefined): boolean {
  if (!expectedSecret) return false
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false
  return secureCompare(authHeader.slice(7), expectedSecret)
}
