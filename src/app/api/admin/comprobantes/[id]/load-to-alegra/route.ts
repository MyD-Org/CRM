import {
  ALEGRA_ATTACHMENT_MAX_BYTES,
  attachFileToPayment,
  createPayment,
  listOpenInvoicesByContact,
} from "@/lib/alegra"
import { adminNotFoundResponse, requireAdminPlus } from "@/lib/admin-route-guard"
import { getAdmin, markLoadedFromAlegra, toAdminDto } from "@/lib/payment-receipts"
import { parseLoadBody, validateAllocations } from "@/lib/receipt-alegra-load"
import { getR2 } from "@/lib/r2"
import { getTenantByIdFromDb } from "@/lib/tenants"

// POST /api/admin/comprobantes/[id]/load-to-alegra — crea el pago REAL en Alegra desde el
// backoffice (botón "Cargar en Alegra" del diálogo). El admin eligió método, cuenta y a qué
// facturas abiertas se imputa; monto/fecha son corregibles (el comprobante manda) y lo
// declarado queda en declared_* cuando difiere. Pasos:
//   1. validar el body (400s de forma, luego cruce contra saldos reales de Alegra)
//   2. createPayment en Alegra — si Alegra falla ⇒ 502 y la fila queda intacta
//   3. adjuntar el comprobante al pago — best-effort: si falla, el pago queda cargado igual
//   4. markLoadedFromAlegra — UPDATE condicional `alegra_payment_id IS NULL`; 0 filas ⇒ 409
// No hay deshacer ni re-carga con alegra_payment_id: Alegra no tiene idempotency-key y la
// guarda es ese UPDATE (quien crea el pago es quien marca la fila, una sola vez).

export const maxDuration = 60

const NO_STORE = { "Cache-Control": "private, no-store" }

const NOTES_CARGA = "Informado por el cliente desde el portal"

const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

type IdParams = { params: Promise<{ id: string }> }

function badRequest(error: string): Response {
  return Response.json({ error, code: "invalid" }, { status: 400, headers: NO_STORE })
}

export async function POST(req: Request, { params }: IdParams) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const now = new Date()
  const body = await req.json().catch(() => null)
  const parsed = parseLoadBody(body, now)
  if (!parsed.ok) return badRequest(parsed.error)

  const { id } = await params
  const row = await getAdmin(guard.tenantId, id)
  if (!row) return adminNotFoundResponse()
  if (row.alegraPaymentId !== null) {
    return Response.json(
      { error: "Este comprobante ya fue cargado en Alegra", code: "already_loaded" },
      { status: 409, headers: NO_STORE },
    )
  }

  const config = await getTenantByIdFromDb(guard.tenantId)
  if (!config) {
    console.error(`[admin/comprobantes] sin config para tenant "${guard.tenantId}" en load-to-alegra`)
    return Response.json(
      { error: "No pudimos preparar la carga, intente nuevamente en unos minutos", code: "internal_error" },
      { status: 500, headers: NO_STORE },
    )
  }

  let openInvoices
  try {
    openInvoices = await listOpenInvoicesByContact(config, row.codigocliente)
  } catch (err) {
    console.error(`[admin/comprobantes] Alegra respondió mal listando facturas de ${id}:`, err)
    return Response.json(
      { error: "Alegra no respondió bien, intente nuevamente en unos minutos", code: "alegra_error" },
      { status: 502, headers: NO_STORE },
    )
  }

  // amount/paidOn se toman del formulario cuando el admin los corrigió; si no, los de la fila.
  const finalAmount = parsed.value.amount ?? row.amount
  const finalPaidOn = parsed.value.paidOn ?? row.paidOn
  const allocationsCheck = validateAllocations(parsed.value.allocations, openInvoices, finalAmount)
  if (!allocationsCheck.ok) return badRequest(allocationsCheck.error)

  let created
  try {
    created = await createPayment(config, {
      contactAlegraId: row.codigocliente,
      date: finalPaidOn,
      paymentMethod: parsed.value.method,
      bankAccountId: parsed.value.bankAccountId ?? undefined,
      invoices: parsed.value.allocations.map((a) => ({ alegraId: a.invoiceId, amount: Number(a.amount) })),
      notes: NOTES_CARGA,
    })
  } catch (err) {
    // Alegra rechazó el pago: la fila NO se tocó y el admin puede corregir y reintentar.
    console.error(`[admin/comprobantes] Alegra rechazó el pago del comprobante ${id}:`, err)
    return Response.json(
      { error: "Alegra rechazó el pago. Revise los datos y reintente.", code: "alegra_error" },
      { status: 502, headers: NO_STORE },
    )
  }

  // Adjunto best-effort: si R2 no está, el objeto falta, supera los 2 MB de Alegra o el
  // attach falla, el pago queda cargado igual y se registra (no se revierte nada).
  try {
    const r2 = getR2()
    if (!r2 || !row.fileKey || row.fileSize === null) {
      console.info(JSON.stringify({ event: "payment_receipt_attach_skipped", receiptId: id, reason: "sin_storage" }))
    } else if (row.fileSize > ALEGRA_ATTACHMENT_MAX_BYTES) {
      console.info(JSON.stringify({ event: "payment_receipt_attach_skipped", receiptId: id, reason: "file_too_large" }))
    } else {
      const bytes = await r2.getObject(row.fileKey, { maxBytes: ALEGRA_ATTACHMENT_MAX_BYTES })
      if (!bytes) {
        console.info(JSON.stringify({ event: "payment_receipt_attach_skipped", receiptId: id, reason: "object_missing" }))
      } else {
        const fallbackName = `comprobante.${MIME_EXT[row.fileMime ?? ""] ?? "bin"}`
        await attachFileToPayment(config, created.alegraId, {
          name: row.fileOriginalName ?? fallbackName,
          contentType: row.fileMime ?? "application/octet-stream",
          bytes,
        })
      }
    }
  } catch (err) {
    console.error(`[admin/comprobantes] adjunto falló para el pago ${created.alegraId} del comprobante ${id}:`, err)
  }

  const alegraPaymentIdNum = Number(created.alegraId)
  const updated = await markLoadedFromAlegra(
    guard.tenantId,
    id,
    {
      alegraPaymentId: alegraPaymentIdNum,
      alegraPaymentNumber: created.number,
      amount: finalAmount,
      paidOn: finalPaidOn,
      declaredAmount: Number(finalAmount) !== Number(row.amount) ? row.amount : null,
      declaredPaidOn: finalPaidOn !== row.paidOn ? row.paidOn : null,
      adminUserId: guard.user.id,
    },
    now,
  )
  if (!updated) {
    // Alguien cargó este comprobante mientras tanto: el UPDATE condicional no aplicó. El
    // pago de Alegra ya existe — queda registrado para revisión manual (no se puede anular
    // automáticamente sin riesgo de tocar pagos ajenos).
    console.error(
      JSON.stringify({
        event: "payment_receipt_load_race",
        tenant: guard.tenantId,
        receiptId: id,
        alegraPaymentId: alegraPaymentIdNum,
        actor: { id: guard.user.id },
        at: now.toISOString(),
      }),
    )
    return Response.json(
      { error: "Este comprobante ya fue cargado en Alegra por otro usuario", code: "already_loaded" },
      { status: 409, headers: NO_STORE },
    )
  }

  console.info(
    JSON.stringify({
      event: "payment_receipt_loaded_to_alegra",
      tenant: guard.tenantId,
      receiptId: id,
      alegraPaymentId: alegraPaymentIdNum,
      alegraPaymentNumber: created.number,
      amount: finalAmount,
      paidOn: finalPaidOn,
      declaredCorrected: updated.declaredAmount !== null || updated.declaredPaidOn !== null,
      actor: { id: guard.user.id, name: guard.user.name, email: guard.user.email },
      at: now.toISOString(),
    }),
  )

  const fresh = await getAdmin(guard.tenantId, id)
  return Response.json(toAdminDto(fresh ?? updated, now), { headers: NO_STORE })
}
