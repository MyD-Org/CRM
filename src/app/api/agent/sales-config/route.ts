import { authAgentTenantRequest } from "@/lib/agent-auth"
import { getTenantConfig } from "@/lib/tenant-context"
import { listPriceLists, listPaymentTerms, listSellers, listTaxes, listCurrencies } from "@/lib/alegra"

// GET /api/agent/sales-config
// Configuración comercial del tenant desde Alegra: listas de precio, condiciones de pago,
// vendedores, impuestos y monedas — todo lo que el agente necesita para hablar de precios
// y armar cotizaciones. Incluye shop_url (env NEXT_PUBLIC_SHOP_URL) para compartir el link
// de la tienda cuando exista.
export async function GET(req: Request) {
  try {
    const tenant = await getTenantConfig()
    const auth = authAgentTenantRequest(req, tenant.id)
    if (!auth) {
      console.warn("[agent/sales-config] 401 — request sin crm_token válido (Authorization Bearer)")
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }

    const [priceLists, paymentTerms, sellers, taxes, currencies] = await Promise.all([
      listPriceLists(tenant),
      listPaymentTerms(tenant),
      listSellers(tenant),
      listTaxes(tenant),
      listCurrencies(tenant),
    ])

    console.log(
      `[agent/sales-config] tenant=${tenant.id} cliente=${auth.codigocliente} → ` +
        `${priceLists.length} listas, ${paymentTerms.length} términos, ${sellers.length} vendedores`,
    )

    return Response.json({
      shop_url: process.env.NEXT_PUBLIC_SHOP_URL ?? null,
      price_lists: priceLists
        .filter((p) => p.status === "active")
        .map((p) => ({ id: p.alegraId, name: p.name })),
      payment_terms: paymentTerms.map((t) => ({ id: t.alegraId, name: t.name, days: t.days })),
      sellers: sellers
        .filter((s) => s.status === "active")
        .map((s) => ({ id: s.alegraId, name: s.name })),
      taxes: taxes
        .filter((t) => t.status === "active")
        .map((t) => ({ id: t.alegraId, name: t.name, percentage: t.percentage })),
      currencies: currencies.map((c) => ({ code: c.code, name: c.name, symbol: c.symbol })),
    })
  } catch (err) {
    console.error("agent/sales-config error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
