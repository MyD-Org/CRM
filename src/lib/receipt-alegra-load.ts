// Validación pura del body de POST …/comprobantes/{id}/load-to-alegra. Separada de la ruta
// para testearla sin HTTP ni DB. Los errores son en español claro y mostrables: los pinta
// el diálogo de "Cargar en Alegra". La revisión contra los saldos reales (validateAllocations)
// se hace aparte porque necesita las facturas abiertas de Alegra.

import { ALEGRA_PAYMENT_METHODS, type AlegraPaymentMethod } from "@/lib/alegra"
import { isValidPaidOn, parseAmount } from "@/lib/receipt-validation"

/** Métodos para los que Alegra exige saber en qué cuenta entró el dinero. */
export const METHODS_REQUIRING_BANK = ["transfer", "deposit", "check"] as const

export interface OpenInvoiceForValidation {
  alegraId: string
  number: string | null
  balance: number
}

export interface ParsedLoadBody {
  method: AlegraPaymentMethod
  bankAccountId: string | null
  /** null = el pago se carga con el monto declarado en la fila. */
  amount: string | null
  /** null = el pago se carga con la fecha declarada en la fila. */
  paidOn: string | null
  allocations: { invoiceId: string; amount: string }[]
}

export type LoadBodyValidation = { ok: true; value: ParsedLoadBody } | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** String decimal ("12345.67") → centavos enteros, para sumar y comparar sin drift de float. */
export function toCents(amount: string): number {
  return Math.round(Number(amount) * 100)
}

/**
 * Validación de la FORMA del body: método del enum de Alegra, cuenta bancaria según método,
 * allocations no vacío con ids únicos y montos parseables, amount/paidOn parseables si vienen
 * (si no, la ruta usa los de la fila). El cruce contra saldos reales va en validateAllocations.
 */
export function parseLoadBody(body: unknown, now: Date): LoadBodyValidation {
  const b = isRecord(body) ? body : {}

  const method = ALEGRA_PAYMENT_METHODS.find((m) => m === b.method)
  if (!method) return { ok: false, error: "El medio de pago no es válido para Alegra" }

  let bankAccountId: string | null = null
  if (b.bankAccountId !== undefined && b.bankAccountId !== null && b.bankAccountId !== "") {
    if (typeof b.bankAccountId !== "string" || !/^[0-9]+$/.test(b.bankAccountId)) {
      return { ok: false, error: "La cuenta bancaria elegida no es válida" }
    }
    bankAccountId = b.bankAccountId
  }
  if ((METHODS_REQUIRING_BANK as readonly string[]).includes(method) && !bankAccountId) {
    return { ok: false, error: "Elegí la cuenta bancaria del pago" }
  }

  let amount: string | null = null
  if (b.amount !== undefined && b.amount !== null && b.amount !== "") {
    amount = parseAmount(b.amount)
    if (amount === null) return { ok: false, error: "Ingresá un monto válido (mayor a 0, hasta 2 decimales)" }
  }

  let paidOn: string | null = null
  if (b.paidOn !== undefined && b.paidOn !== null && b.paidOn !== "") {
    if (!isValidPaidOn(b.paidOn, now)) {
      return { ok: false, error: "Ingresá una fecha de pago válida (no futura)" }
    }
    // isValidPaidOn verifica el formato YYYY-MM-DD: acá ya es un string válido.
    paidOn = String(b.paidOn)
  }

  if (!Array.isArray(b.allocations) || b.allocations.length === 0) {
    return { ok: false, error: "Elegí al menos una factura a la que imputar el pago" }
  }
  const seen = new Set<string>()
  const allocations: { invoiceId: string; amount: string }[] = []
  for (const item of b.allocations) {
    if (!isRecord(item) || typeof item.invoiceId !== "string" || item.invoiceId.length === 0) {
      return { ok: false, error: "La distribución entre facturas es inválida" }
    }
    if (seen.has(item.invoiceId)) {
      return { ok: false, error: "Hay facturas repetidas en la distribución" }
    }
    const itemAmount = parseAmount(item.amount)
    if (itemAmount === null) {
      return { ok: false, error: "Ingresá montos mayores a 0 (hasta 2 decimales) en cada factura" }
    }
    seen.add(item.invoiceId)
    allocations.push({ invoiceId: item.invoiceId, amount: itemAmount })
  }

  return { ok: true, value: { method, bankAccountId, amount, paidOn, allocations } }
}

/**
 * Cruce de las allocations contra las facturas ABIERTAS del cliente (saldo real de Alegra):
 * cada factura imputada tiene que existir entre las abiertas, no pasarse de su saldo y la
 * suma tiene que ser EXACTAMENTE el monto del pago (nada de pagos parciales sin aviso).
 */
export function validateAllocations(
  allocations: { invoiceId: string; amount: string }[],
  openInvoices: OpenInvoiceForValidation[],
  amount: string,
): { ok: true } | { ok: false; error: string } {
  const byId = new Map(openInvoices.map((inv) => [inv.alegraId, inv]))
  let sumCents = 0
  for (const alloc of allocations) {
    const inv = byId.get(alloc.invoiceId)
    if (!inv) {
      return { ok: false, error: "Una de las facturas elegidas no está entre las facturas abiertas del cliente" }
    }
    const allocCents = toCents(alloc.amount)
    if (allocCents > Math.round(inv.balance * 100)) {
      const label = inv.number ?? inv.alegraId
      return { ok: false, error: `El monto asignado a la factura ${label} supera su saldo pendiente` }
    }
    sumCents += allocCents
  }
  if (sumCents !== toCents(amount)) {
    return { ok: false, error: "La distribución entre facturas no coincide con el monto del pago" }
  }
  return { ok: true }
}
