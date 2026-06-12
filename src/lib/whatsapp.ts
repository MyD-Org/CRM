import type { Factura, Pago, Presupuesto, FacturaEstado } from "@/types"

const WHATSAPP_PHONE = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? "5493757300293"

const FACTURA_ESTADO_LABELS: Record<FacturaEstado, string> = {
  pendiente: "Pendiente",
  vencida: "Vencida",
  pagada: "Pagada",
}

export type WhatsAppFacturaIntent = "pagar" | "consulta"
export type WhatsAppPresupuestoIntent = "avanzar" | "consulta"

export function openWhatsApp(message: string) {
  const url = `https://wa.me/${WHATSAPP_PHONE}?text=${encodeURIComponent(message)}`
  window.open(url, "_blank", "noopener,noreferrer")
}

export function buildFacturasWhatsAppMessage(
  intent: WhatsAppFacturaIntent,
  razonsocial: string,
  cuentaCorriente: number,
  facturas: Pick<Factura, "id" | "tipo" | "importe" | "estado">[],
  formatCurrency: (n: number) => string,
): string {
  const header = `Hola Central LED, les escribo de ${razonsocial} (Cta. Cte. N° ${cuentaCorriente}).`
  const intro =
    intent === "pagar"
      ? "Quiero coordinar el pago de los siguientes comprobantes:"
      : "Tengo una consulta sobre los siguientes comprobantes:"
  const lines = facturas
    .map((f) => `• ${f.id} — ${f.tipo} — ${formatCurrency(f.importe)} (${FACTURA_ESTADO_LABELS[f.estado]})`)
    .join("\n")
  const total = facturas.reduce((sum, f) => sum + f.importe, 0)
  const footer = intent === "consulta" ? "\n\nMi consulta: " : ""
  return `${header}\n\n${intro}\n${lines}\n\nTotal: ${formatCurrency(total)}${footer}`
}

export function buildPagosWhatsAppMessage(
  razonsocial: string,
  cuentaCorriente: number,
  pagos: Pick<Pago, "id" | "fecha" | "medio" | "monto">[],
  formatCurrency: (n: number) => string,
): string {
  const header = `Hola Central LED, les escribo de ${razonsocial} (Cta. Cte. N° ${cuentaCorriente}).`
  const intro = "Tengo una consulta sobre los siguientes pagos:"
  const lines = pagos
    .map((p) => `• ${p.id} — ${p.fecha} — ${p.medio} — ${formatCurrency(p.monto)}`)
    .join("\n")
  return `${header}\n\n${intro}\n${lines}\n\nMi consulta: `
}

export function buildPresupuestosWhatsAppMessage(
  intent: WhatsAppPresupuestoIntent,
  razonsocial: string,
  cuentaCorriente: number,
  presupuestos: Pick<Presupuesto, "id" | "fecha" | "total">[],
  formatCurrency: (n: number) => string,
): string {
  const header = `Hola Central LED, les escribo de ${razonsocial} (Cta. Cte. N° ${cuentaCorriente}).`
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
