// URL de la DB de test para los tests de integración. SIEMPRE local y con nombre que incluya
// "test": es la red de seguridad para que estos tests (que truncan tablas) NUNCA puedan tocar
// una DB real. La URL de prod vive en .env.local; acá la ignoramos a propósito.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://localhost:5432/crm_test"

// URL a la base "postgres" del mismo servidor, para poder crear la DB de test (CREATE DATABASE
// no puede correr sobre la propia DB que se está creando).
export const ADMIN_DATABASE_URL = TEST_DATABASE_URL.replace(/\/[^/]+(\?.*)?$/, "/postgres")

/**
 * Falla ruidosamente si la URL no parece una DB de test LOCAL. Evita que un DATABASE_URL de
 * prod (ej. el de .env.local) se cuele y los tests trunquen datos reales. La llaman el
 * global-setup (antes de migrar) y el helper de truncate (antes de borrar).
 */
export function assertLocalTestDb(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`TEST_DATABASE_URL inválida: ${url}`)
  }
  const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
  const dbName = parsed.pathname.replace(/^\//, "")
  const looksLikeTest = /test/i.test(dbName)
  if (!isLocalHost || !looksLikeTest) {
    throw new Error(
      `Los tests de integración solo corren contra una DB LOCAL de test (host localhost, nombre con "test"). ` +
        `Recibí host="${parsed.hostname}" db="${dbName}". Abortando para no tocar datos reales.`,
    )
  }
}
