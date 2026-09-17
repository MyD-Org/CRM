// Ping al Shop para que vuelva a leer la config de cuotas (contrato platform/contracts/cuotas/v2,
// punto 2). SIN payload: el Shop re-hace el GET /api/internal/shop/cuotas, así un ping no puede
// inyectar configuración.
//
// Se llama DESPUÉS de persistir y NUNCA tira: si el Shop no responde, el guardado ya quedó y el
// backoffice avisa "El Shop se actualizará en el próximo ciclo" (cron del Shop, ≤ 6 h).
// Sin SHOP_INTERNAL_URL o SHOP_CRM_SECRET (ej. entornos sin Shop) es un no-op.

export const PING_TIMEOUT_MS = 5000

export async function pingShopRevalidarCuotas(): Promise<{ propagado: boolean }> {
  const base = process.env.SHOP_INTERNAL_URL?.trim()
  const secret = process.env.SHOP_CRM_SECRET
  if (!base || !secret) return { propagado: false }

  const url = `${base.replace(/\/+$/, "")}/api/internal/cuotas/revalidar`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: controller.signal,
      cache: "no-store",
    })
    if (!res.ok) console.warn(`[cuotas] ping al Shop respondió ${res.status}`)
    return { propagado: res.ok }
  } catch (err) {
    console.warn(`[cuotas] ping al Shop falló: ${err instanceof Error ? err.name : "error"}`)
    return { propagado: false }
  } finally {
    clearTimeout(timer)
  }
}
