import { and, eq } from "drizzle-orm"
import { Resend } from "resend"
import { getDb } from "@/db"
import { notificationLog, notificationRules, tenants as tenantsTable } from "@/db/schema"
import { getClientes, getFacturas } from "@/lib/flexxus"
import type { TenantConfig } from "@/lib/tenants"
import type { Cliente, Factura } from "@/types"

// ── Gestor de Cobranza ──────────────────────────────────────────────────────
// Recorre las facturas impagas de cada cliente, cruza con las reglas del
// tenant (días antes/después del vencimiento) y envía recordatorios por email.
// La deduplicación la garantiza el unique index nl_dedup de notification_log.

export interface NotificationResult {
  sent: number
  skipped: number
  failed: number
  details: string[]
}

interface PendingNotification {
  cliente: Cliente
  factura: Factura
  type: string // 'before_due_3' | 'after_due_7' ...
  diasDiff: number // negativo = faltan días, positivo = días de mora
}

function parseFecha(d: string): Date {
  const [dd, mm, yyyy] = d.split("/").map(Number)
  return new Date(yyyy, mm - 1, dd)
}

function diasDesdeVencimiento(factura: Factura, hoy: Date): number {
  const venc = parseFecha(factura.vencimiento)
  return Math.round((hoy.getTime() - venc.getTime()) / 86_400_000)
}

function fmt(n: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(n)
}

function saldoDe(f: Factura): number {
  return f.importe - (f.pagado ?? 0)
}

function tenantConfigFromRow(row: typeof tenantsTable.$inferSelect): TenantConfig {
  return {
    id: row.id,
    name: row.name,
    subtitle: row.subtitle,
    logoPath: row.logoPath,
    flexxusBaseUrl: row.flexxusBaseUrl,
    flexxusToken: row.flexxusToken,
    flexxusMock: row.flexxusMock,
    whatsappNumber: row.whatsappNumber,
    resendFrom: row.resendFrom,
    aiApiBaseUrl: row.aiApiUrl,
    aiApiKey: row.aiApiKey,
    aiAgentId: row.aiAgentId,
  }
}

function buildEmail(tenant: TenantConfig, cliente: Cliente, items: PendingNotification[]) {
  const vencidas = items.filter((i) => i.diasDiff > 0)
  const porVencer = items.filter((i) => i.diasDiff <= 0)

  const subject = vencidas.length
    ? `${tenant.name} — Tenés ${vencidas.length === 1 ? "una factura vencida" : `${vencidas.length} facturas vencidas`}`
    : `${tenant.name} — Recordatorio de vencimiento`

  const filas = items
    .map((i) => {
      const estado =
        i.diasDiff > 0 ? `vencida hace ${i.diasDiff} día${i.diasDiff === 1 ? "" : "s"}` : i.diasDiff === 0 ? "vence hoy" : `vence en ${-i.diasDiff} día${i.diasDiff === -1 ? "" : "s"}`
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${i.factura.id}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${i.factura.vencimiento}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${fmt(saldoDe(i.factura))}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:${i.diasDiff > 0 ? "#b91c1c" : "#92400e"}">${estado}</td>
      </tr>`
    })
    .join("")

  const total = items.reduce((acc, i) => acc + saldoDe(i.factura), 0)

  const html = `
  <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111827">
    <h2 style="font-size:18px">${tenant.name}</h2>
    <p>Hola ${cliente.razonsocial},</p>
    <p>${vencidas.length ? "Te recordamos que tenés facturas con saldo vencido:" : "Te recordamos los próximos vencimientos de tu cuenta corriente:"}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="text-align:left;color:#6b7280">
        <th style="padding:8px 12px">Factura</th><th style="padding:8px 12px">Vencimiento</th>
        <th style="padding:8px 12px;text-align:right">Saldo</th><th style="padding:8px 12px">Estado</th>
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <p style="font-weight:600">Total: ${fmt(total)}</p>
    <p>Podés ver el detalle y descargar tus facturas desde el portal de clientes.</p>
    <p style="color:#6b7280;font-size:12px">Si ya realizaste el pago, desestimá este mensaje. Ante cualquier duda contactate con atención al cliente.</p>
  </div>`

  return { subject, html }
}

async function sendEmail(tenant: TenantConfig, to: string, subject: string, html: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    // Dry-run en entornos sin Resend configurado: loguea en vez de enviar
    console.log(`[notifications dry-run] to=${to} subject="${subject}"`)
    return
  }
  const resend = new Resend(apiKey)
  const { error } = await resend.emails.send({ from: tenant.resendFrom, to, subject, html })
  if (error) throw new Error(error.message)
}

export async function runNotifications(filter?: {
  tenantId?: string
  codigocliente?: string
}): Promise<NotificationResult> {
  const db = getDb()
  const result: NotificationResult = { sent: 0, skipped: 0, failed: 0, details: [] }
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)

  const rules = await db
    .select()
    .from(notificationRules)
    .innerJoin(tenantsTable, eq(notificationRules.tenantId, tenantsTable.id))
    .where(
      filter?.tenantId
        ? and(eq(notificationRules.enabled, true), eq(notificationRules.tenantId, filter.tenantId))
        : eq(notificationRules.enabled, true),
    )

  for (const { notification_rules: rule, tenants: tenantRow } of rules) {
    const tenant = tenantConfigFromRow(tenantRow)
    const daysBefore = rule.daysBefore as number[]
    const daysAfter = rule.daysAfter as number[]
    const channels = rule.channels as string[]

    if (!channels.includes("email")) continue

    let clientes = await getClientes(tenant)
    if (filter?.codigocliente) clientes = clientes.filter((c) => c.codigocliente === filter.codigocliente)

    for (const cliente of clientes) {
      if (!cliente.email) {
        result.skipped++
        result.details.push(`${cliente.codigocliente}: sin email, omitido`)
        continue
      }

      const facturas = await getFacturas(tenant, cliente.codigocliente)
      const pendientes: PendingNotification[] = []

      for (const factura of facturas) {
        if (factura.estado === "pagada") continue
        const diff = diasDesdeVencimiento(factura, hoy)

        let type: string | null = null
        if (diff < 0 && daysBefore.includes(-diff)) type = `before_due_${-diff}`
        else if (diff >= 0 && daysAfter.includes(diff)) type = `after_due_${diff}`
        if (!type) continue

        // Deduplicación: si ya se ENVIÓ (status sent) para (tenant, cliente,
        // factura, type, canal), saltear. Los failed se reintentan.
        const [existing] = await db
          .select({ id: notificationLog.id })
          .from(notificationLog)
          .where(
            and(
              eq(notificationLog.tenantId, tenant.id),
              eq(notificationLog.codigocliente, cliente.codigocliente),
              eq(notificationLog.facturaId, factura.id),
              eq(notificationLog.type, type),
              eq(notificationLog.channel, "email"),
              eq(notificationLog.status, "sent"),
            ),
          )
        if (existing) {
          result.skipped++
          continue
        }

        pendientes.push({ cliente, factura, type, diasDiff: diff })
      }

      if (!pendientes.length) continue

      // Un solo email por cliente agrupando todas sus facturas
      const { subject, html } = buildEmail(tenant, cliente, pendientes)
      let status = "sent"
      let errorMsg: string | null = null
      try {
        await sendEmail(tenant, cliente.email, subject, html)
        result.sent += pendientes.length
        result.details.push(`${cliente.codigocliente}: email con ${pendientes.length} factura(s)`)
      } catch (err) {
        status = "failed"
        errorMsg = err instanceof Error ? err.message : String(err)
        result.failed += pendientes.length
        result.details.push(`${cliente.codigocliente}: ERROR ${errorMsg}`)
      }

      for (const p of pendientes) {
        await db
          .insert(notificationLog)
          .values({
            tenantId: tenant.id,
            codigocliente: cliente.codigocliente,
            facturaId: p.factura.id,
            type: p.type,
            channel: "email",
            status,
            error: errorMsg,
          })
          .onConflictDoUpdate({
            target: [
              notificationLog.tenantId,
              notificationLog.codigocliente,
              notificationLog.facturaId,
              notificationLog.type,
              notificationLog.channel,
            ],
            set: { status, error: errorMsg, sentAt: new Date() },
          })
      }
    }
  }

  return result
}
