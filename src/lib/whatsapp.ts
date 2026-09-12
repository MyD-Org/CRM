import type { Factura, Pago, Presupuesto, FacturaEstado } from "@/types"

const FACTURA_ESTADO_LABELS: Record<FacturaEstado, string> = {
  pendiente: "Pendiente",
  vencida: "Vencida",
  pagada: "Pagada",
  anulada: "Anulada",
}

export type WhatsAppFacturaIntent = "pagar" | "consulta"
export type WhatsAppPresupuestoIntent = "avanzar" | "consulta"

export function openWhatsApp(phone: string, message: string) {
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
  window.open(url, "_blank", "noopener,noreferrer")
}

/**
 * Encabezado de los mensajes a la empresa. Identifica al cliente con el CUIT, que es un dato
 * real que la empresa reconoce. Antes decía "Cta. Cte. N° 49", pero ese número era el id
 * interno del contacto en Alegra presentado como número de cuenta corriente, que Alegra no tiene.
 */
function encabezado(tenantName: string, razonsocial: string, cuit: string): string {
  const id = cuit ? ` (CUIT ${cuit})` : ""
  return `Hola ${tenantName}, les escribo de ${razonsocial}${id}.`
}

export function buildFacturasWhatsAppMessage(
  intent: WhatsAppFacturaIntent,
  tenantName: string,
  razonsocial: string,
  cuit: string,
  facturas: Pick<Factura, "id" | "tipo" | "importe" | "estado" | "pagado">[],
  formatCurrency: (n: number) => string,
): string {
  const header = encabezado(tenantName, razonsocial, cuit)
  const intro =
    intent === "pagar"
      ? "Quiero coordinar el pago de los siguientes comprobantes:"
      : "Tengo una consulta sobre los siguientes comprobantes:"
  const saldoDe = (f: Pick<Factura, "importe" | "pagado" | "estado">) =>
    f.estado === "anulada" ? 0 : f.importe - (f.pagado ?? 0)
  const lines = facturas
    .map((f) => {
      const parcial = f.pagado && f.pagado > 0 && f.pagado < f.importe
      const monto = parcial ? `saldo ${formatCurrency(saldoDe(f))}` : formatCurrency(f.importe)
      return `• ${f.id} — ${f.tipo} — ${monto} (${FACTURA_ESTADO_LABELS[f.estado]})`
    })
    .join("\n")
  const total = facturas.reduce((sum, f) => sum + saldoDe(f), 0)
  const footer = intent === "consulta" ? "\n\nMi consulta: " : ""
  return `${header}\n\n${intro}\n${lines}\n\nTotal: ${formatCurrency(total)}${footer}`
}

export function buildPagosWhatsAppMessage(
  tenantName: string,
  razonsocial: string,
  cuit: string,
  pagos: Pick<Pago, "id" | "fecha" | "medio" | "monto">[],
  formatCurrency: (n: number) => string,
): string {
  const header = encabezado(tenantName, razonsocial, cuit)
  const intro = "Tengo una consulta sobre los siguientes pagos:"
  const lines = pagos
    .map((p) => `• ${p.id} — ${p.fecha} — ${p.medio} — ${formatCurrency(p.monto)}`)
    .join("\n")
  return `${header}\n\n${intro}\n${lines}\n\nMi consulta: `
}

export function buildPresupuestosWhatsAppMessage(
  intent: WhatsAppPresupuestoIntent,
  tenantName: string,
  razonsocial: string,
  cuit: string,
  presupuestos: Pick<Presupuesto, "id" | "fecha" | "total">[],
  formatCurrency: (n: number) => string,
): string {
  const header = encabezado(tenantName, razonsocial, cuit)
  const intro =
    intent === "avanzar"
      ? "Quiero avanzar con los siguientes presupuestos:"
      : "Tengo una consulta sobre los siguientes presupuestos:"
  const lines = presupuestos
    .map((p) => `• ${p.id} — ${p.fecha} — ${formatCurrency(p.total)}`)
    .join("\n")
  const footer = intent === "consulta" ? "\n\nMi consulta: " : ""
  return `${header}\n\n${intro}\n${lines}${footer}`
}
