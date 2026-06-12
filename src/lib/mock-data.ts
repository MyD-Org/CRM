import type { Cliente, CondicionesComerciales, Factura, Pago, Presupuesto } from "@/types"

export const mockCliente: Cliente = {
  codigocliente: "CLI001",
  razonsocial: "Ferretería Sol S.R.L.",
  cuit: "30-71045887-3",
  numerocuentacorriente: 1042,
  limitecredito: 800000,
  deudatotal: 533761.70,
  saldovencido: 345781.70,
  saldoavencer: 187980.00,
}

export const mockFacturas: Factura[] = [
  { id: "FA-0001-00012876", tipo: "Factura A", emision: "28/05/2026", vencimiento: "27/06/2026", importe: 98252, estado: "pendiente" },
  { id: "FA-0001-00012740", tipo: "Factura A", emision: "12/05/2026", vencimiento: "11/06/2026", importe: 189728, estado: "pendiente", pagado: 100000 },
  { id: "FA-0001-00012588", tipo: "Factura A", emision: "22/04/2026", vencimiento: "22/05/2026", importe: 151250, estado: "vencida" },
  { id: "FA-0001-00012511", tipo: "Factura A", emision: "15/04/2026", vencimiento: "15/05/2026", importe: 105959.70, estado: "vencida" },
  { id: "FA-0001-00012390", tipo: "Factura A", emision: "28/03/2026", vencimiento: "27/04/2026", importe: 90750, estado: "pagada" },
  { id: "FA-0001-00012245", tipo: "Factura A", emision: "10/03/2026", vencimiento: "09/04/2026", importe: 233989.80, estado: "pagada" },
]

export const mockPagos: Pago[] = [
  { id: "RC-0001-00000218", fecha: "05/06/2026", facturas: [{ factura: "FA-0001-00012740", imputado: 100000 }], medio: "Transferencia", monto: 100000 },
  { id: "RC-0001-00000191", fecha: "08/04/2026", facturas: [{ factura: "FA-0001-00012390", imputado: 90750 }, { factura: "FA-0001-00012245", imputado: 233989.80 }], medio: "Cheque", monto: 324739.80 },
]

export const mockCondiciones: CondicionesComerciales = {
  condicionPago: "Cuenta corriente 30 días",
  plazoDias: 30,
  listaPrecios: "Lista 2 — Mayorista",
  descuentos: [
    { concepto: "Iluminación LED", porcentaje: 12 },
    { concepto: "Cables y conductores", porcentaje: 8 },
    { concepto: "Pago contado", porcentaje: 5 },
  ],
  vendedor: {
    nombre: "Martín Gutiérrez",
    telefono: "+54 9 3757 30-1122",
    email: "mgutierrez@central-led.com",
  },
  transporte: {
    modalidad: "Expreso a cargo del cliente",
    observaciones: "Despachos lunes y jueves. Pedidos mayores a $500.000 con envío bonificado.",
  },
}

export const mockPresupuestos: Presupuesto[] = [
  { id: "PR-0001-00000045", fecha: "01/06/2026", validoHasta: "15/06/2026", total: 245000, estado: "vigente" },
  { id: "PR-0001-00000038", fecha: "15/05/2026", validoHasta: "29/05/2026", total: 87500, estado: "vencido" },
  { id: "PR-0001-00000031", fecha: "02/05/2026", validoHasta: "16/05/2026", total: 320000, estado: "aceptado" },
]
