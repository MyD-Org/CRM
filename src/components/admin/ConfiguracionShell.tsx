"use client"

import { useState } from "react"
import { Card, Tabs } from "@myd-org/ui"
import { CatalogManager } from "./CatalogManager"
import { ReceiptsEmailForm } from "./ReceiptsEmailForm"
import { ScheduleForm, type Schedule } from "./ScheduleForm"

type PriceColumn = { key: string; label: string }

type PriceList = {
  id: string
  tenantId: string
  name: string
  category: string
  priceColumns: PriceColumn[]
  fileName: string | null
  active: boolean
  uploadedAt: string
  createdAt: string
  itemCount: number
}

type PaymentCondition = { method: string; description: string }

interface Props {
  // `false` para admins: se oculta el tab Catálogo (superadmin-only) y arranca en Horarios.
  showCatalog: boolean
  // `false` para operator (la página hace notFound antes, pero el tab también se gatea acá).
  showReceipts: boolean
  initialLists: PriceList[]
  initialPaymentConditions: PaymentCondition[]
  initialSchedule: Schedule
  initialReceiptsEmail: string
}

type Tab = "catalogo" | "comprobantes" | "horarios"

export function ConfiguracionShell({
  showCatalog,
  showReceipts,
  initialLists,
  initialPaymentConditions,
  initialSchedule,
  initialReceiptsEmail,
}: Props) {
  const [tab, setTab] = useState<Tab>(showCatalog ? "catalogo" : "horarios")

  const items = [
    ...(showCatalog ? [{ value: "catalogo", label: "Catálogo" }] : []),
    ...(showReceipts ? [{ value: "comprobantes", label: "Comprobantes" }] : []),
    { value: "horarios", label: "Horarios" },
  ]

  return (
    <div className="flex flex-col gap-4">
      <Tabs variant="underline" value={tab} onValueChange={(v) => setTab(v as Tab)} items={items} />

      {tab === "catalogo" && showCatalog && (
        <CatalogManager initialLists={initialLists} initialPaymentConditions={initialPaymentConditions} />
      )}
      {tab === "comprobantes" && showReceipts && (
        <Card
          title="Comprobantes de pago"
          description="Los clientes pueden informar un pago desde el portal (Pagos → Informar pago) adjuntando el comprobante."
        >
          <ReceiptsEmailForm initialReceiptsEmail={initialReceiptsEmail} />
        </Card>
      )}
      {tab === "horarios" && <ScheduleForm initialSchedule={initialSchedule} />}
    </div>
  )
}
