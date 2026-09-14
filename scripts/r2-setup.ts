/**
 * Configuración puntual del bucket R2 de comprobantes (items de ops A0.2 + A0.3 del plan):
 *   - CORS: el navegador del portal sube el archivo DIRECTO a R2 con la URL PUT prefirmada
 *     (presignPut). Sin regla CORS el preflight OPTIONS lo rechaza y el upload nunca parte.
 *     Orígenes: dominios de los tenants (`*.tevro.com.ar`), deploys de preview
 *     (`*.vercel.app`) y localhost para desarrollo.
 *   - Lifecycle: borra los keys `tmp/` a 1 día. Los comprobantes confirmados viven en
 *     `receipts/` y no expiran nunca (respaldo contable).
 *
 *   npx tsx --env-file=.env scripts/r2-setup.ts
 *
 * Lee R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET del env
 * (R2_REGION opcional, default "auto"). Idempotente, pero PISA la config CORS/lifecycle
 * completa del bucket: si hubiera reglas manuales previas, el GET inicial las muestra.
 */
import { AwsV4Signer } from "aws4fetch"
import { r2Config, type R2Config } from "../src/lib/r2"

function requireR2Config(): R2Config {
  const cfg = r2Config()
  if (!cfg) {
    console.error("Faltan R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET en el env")
    process.exit(1)
  }
  return cfg
}

const cfg = requireR2Config()

console.log(`Bucket: ${cfg.bucket} (account ${cfg.accountId})`)

// El PUT del portal manda solo content-type (content-length lo agrega el navegador y
// también va en la firma): con esos dos headers alcanza para el preflight.
const CORS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
    <AllowedOrigin>https://*.tevro.com.ar</AllowedOrigin>
    <AllowedOrigin>https://*.vercel.app</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>content-type</AllowedHeader>
    <AllowedHeader>content-length</AllowedHeader>
    <MaxAgeSeconds>3000</MaxAgeSeconds>
  </CORSRule>
  <CORSRule>
    <AllowedOrigin>http://localhost:3000</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>content-type</AllowedHeader>
    <AllowedHeader>content-length</AllowedHeader>
    <MaxAgeSeconds>60</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`

const LIFECYCLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Rule>
    <ID>tmp-receipts-1-dia</ID>
    <Filter><Prefix>tmp/</Prefix></Filter>
    <Status>Enabled</Status>
    <Expiration><Days>1</Days></Expiration>
  </Rule>
</LifecycleConfiguration>`

async function signedRequest(method: string, query: string, body?: string): Promise<Response> {
  const url = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}?${query}`
  const signer = new AwsV4Signer({
    method,
    url,
    body,
    headers: body ? { "content-type": "application/xml" } : undefined,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: cfg.region,
  })
  const signed = await signer.sign()
  return fetch(new Request(signed.url.toString(), { method: signed.method, headers: signed.headers, body: signed.body }))
}

async function apply(label: string, query: "cors" | "lifecycle", xml: string): Promise<void> {
  const before = await signedRequest("GET", query)
  console.log(`\n── ${label}: GET ?${query} → ${before.status}${before.status === 404 ? " (sin config previa)" : ""}`)
  if (before.status !== 404) console.log((await before.text()).trim())

  const put = await signedRequest("PUT", query, xml)
  console.log(`PUT ?${query} → ${put.status}`)
  if (!put.ok) {
    console.error(await put.text())
    throw new Error(`PUT ?${query} respondió ${put.status}`)
  }

  const after = await signedRequest("GET", query)
  console.log(`Verificación GET → ${after.status}:`)
  console.log((await after.text()).trim())
}

async function main() {
  await apply("CORS (upload directo desde el portal)", "cors", CORS_XML)
  await apply("Lifecycle (tmp/ borrado a 1 día)", "lifecycle", LIFECYCLE_XML)
  console.log("\nOK — bucket configurado.")
}

main().catch((err) => {
  console.error("\nFalló:", err instanceof Error ? err.message : err)
  process.exit(1)
})
