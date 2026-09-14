import { listBankAccounts, listOpenInvoicesByContact } from "@/lib/alegra"
import { adminNotFoundResponse, requireAdminPlus } from "@/lib/admin-route-guard"
import { getAdmin } from "@/lib/payment-receipts"
import { getTenantByIdFromDb } from "@/lib/tenants"

// GET /api/admin/comprobantes/[id]/load-context — contexto del formulario "Cargar en
// Alegra": facturas ABIERTAS del cliente (candidatas a imputar el pago, más vieja primero,
// que es el orden del helper "Repartir") y cuentas bancarias del tenant para el select de
// cuenta destino. Errores de Alegra ⇒ 502 (el diálogo avisa y deja reintentar). Mismo 404
// que el detalle: id inexistente/ajeno/invisible son indistinguibles entre sí.

export const maxDuration = 60

const NO_STORE = { "Cache-Control": "private, no-store" }

type IdParams = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: IdParams) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const { id } = await params
  const row = await getAdmin(guard.tenantId, id)
  if (!row) return adminNotFoundResponse()

  const config = await getTenantByIdFromDb(guard.tenantId)
  if (!config) {
    console.error(`[admin/comprobantes] sin config para tenant "${guard.tenantId}" en load-context`)
    return Response.json(
      { error: "No pudimos preparar la carga, intentá de nuevo en unos minutos", code: "internal_error" },
      { status: 500, headers: NO_STORE },
    )
  }

  try {
    const [openInvoices, bankAccounts] = await Promise.all([
      listOpenInvoicesByContact(config, row.codigocliente),
      listBankAccounts(config),
    ])
    openInvoices.sort((a, b) => a.date.localeCompare(b.date))
    return Response.json(
      {
        openInvoices: openInvoices.map((inv) => ({
          alegraId: inv.alegraId,
          number: inv.number,
          date: inv.date,
          balance: inv.balance,
        })),
        bankAccounts: bankAccounts.map((acc) => ({ alegraId: acc.alegraId, name: acc.name })),
      },
      { headers: NO_STORE },
    )
  } catch (err) {
    console.error(`[admin/comprobantes] Alegra respondió mal en load-context de ${id}:`, err)
    return Response.json(
      { error: "Alegra no respondió bien, intentá de nuevo en unos minutos", code: "alegra_error" },
      { status: 502, headers: NO_STORE },
    )
  }
}
