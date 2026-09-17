"use client"

import { useState } from "react"
import { Card, Tabs } from "@myd-org/ui"
import type { MedioDto, OpcionDto } from "@/lib/cuotas-repo"
import { CatalogManager } from "./CatalogManager"
import { CuotasTab } from "./CuotasTab"
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
  // Medios de pago / Cuotas: admin+ (operator no lo ve; las APIs igual lo rechazan).
  showCuotas: boolean
  initialLists: PriceList[]
  initialPaymentConditions: PaymentCondition[]
  initialSchedule: Schedule
  initialReceiptsEmail: string
  initialMedios: MedioDto[]
  initialOpciones: OpcionDto[]
}

type Tab = "catalogo" | "comprobantes" | "cuotas" | "horarios"

export function ConfiguracionShell({
  showCatalog,
  showReceipts,
  showCuotas,
  initialLists,
  initialPaymentConditions,
  initialSchedule,
  initialReceiptsEmail,
  initialMedios,
  initialOpciones,
}: Props) {
  const [tab, setTab] = useState<Tab>(showCatalog ? "catalogo" : "horarios")

  const items = [
    ...(showCatalog ? [{ value: "catalogo", label: "Catálogo" }] : []),
    ...(showReceipts ? [{ value: "comprobantes", label: "Comprobantes" }] : []),
    ...(showCuotas ? [{ value: "cuotas", label: "Medios de pago / Cuotas" }] : []),
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
      {tab === "cuotas" && showCuotas && <CuotasTab initialMedios={initialMedios} initialOpciones={initialOpciones} />}
      {tab === "horarios" && <ScheduleForm initialSchedule={initialSchedule} />}
    </div>
  )
}
