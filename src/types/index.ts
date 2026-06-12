export interface Cliente {
  codigocliente: string
  razonsocial: string
  cuit: string
  numerocuentacorriente: number
  limitecredito: number
  deudatotal: number
  saldovencido: number
  saldoavencer: number
}

export type FacturaEstado = "pendiente" | "vencida" | "pagada"

export interface Factura {
  id: string
  tipo: string
  emision: string
  vencimiento: string
  importe: number
  estado: FacturaEstado
}

export interface Pago {
  id: string
  fecha: string
  facturaAsociada: string
  medio: string
  monto: number
}

export type PresupuestoEstado = "vigente" | "vencido" | "aceptado"

export interface Presupuesto {
  id: string
  fecha: string
  validoHasta: string
  total: number
  estado: PresupuestoEstado
}

export interface SessionData {
  codigocliente?: string
  razonsocial?: string
  cuit?: string
  email?: string
  isLoggedIn: boolean
}

export interface OtpSessionData {
  identifier?: string
  otp?: string
  otpExpiry?: number
}
