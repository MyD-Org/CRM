export interface Cliente {
  codigocliente: string
  razonsocial: string
  cuit: string
  /** Email de contacto — destino de las notificaciones de cobranza */
  email?: string
  numerocuentacorriente: number
  tipoCuenta: "corriente" | "contado"
  /** Límite de crédito de Alegra. `null` = no cargado: la UI no muestra barra de crédito,
   *  porque con 0 de límite toda deuda aparece como "crédito excedido". */
  limitecredito: number | null
  deudatotal: number
  saldovencido: number
  saldoavencer: number
}

export type FacturaEstado = "pendiente" | "vencida" | "pagada" | "anulada"

export interface Factura {
  id: string
  tipo: string
  emision: string
  vencimiento: string
  importe: number
  estado: FacturaEstado
  /** Monto ya pagado — si es > 0 y < importe, la factura tiene pago parcial */
  pagado?: number
  /**
   * Id del documento en Alegra. El `id` de arriba es el número legible (FV-1-000128),
   * que no sirve para pedirle nada a la API. Opcional porque los fixtures del modo
   * mock no lo tienen: sin esto, la UI deshabilita ver/descargar el PDF.
   */
  alegraId?: string
}

export interface PagoImputacion {
  factura: string
  imputado: number
}

export interface Pago {
  id: string
  fecha: string
  /** Facturas canceladas (total o parcialmente) con este pago */
  facturas: PagoImputacion[]
  medio: string
  monto: number
  /**
   * Id del documento en Alegra. El `id` de arriba es el número legible (FV-1-000128),
   * que no sirve para pedirle nada a la API. Opcional porque los fixtures del modo
   * mock no lo tienen: sin esto, la UI deshabilita ver/descargar el PDF.
   */
  alegraId?: string
}

export type PresupuestoEstado = "vigente" | "vencido" | "aceptado"

export interface Presupuesto {
  id: string
  fecha: string
  validoHasta: string
  total: number
  estado: PresupuestoEstado
  /**
   * Id del documento en Alegra. El `id` de arriba es el número legible (FV-1-000128),
   * que no sirve para pedirle nada a la API. Opcional porque los fixtures del modo
   * mock no lo tienen: sin esto, la UI deshabilita ver/descargar el PDF.
   */
  alegraId?: string
}

/**
 * Condiciones comerciales del cliente. Salen de dos lugares:
 * - Alegra (la ficha del contacto): condición/plazo de pago, lista de precios, vendedor.
 * - La tabla propia `client_commercial_conditions`: descuentos y transporte, que Alegra no modela.
 *
 * Todo es nullable: lo que no está cargado se esconde. Antes, sin datos se devolvía un mock
 * con un vendedor de otra empresa, y el cliente lo veía como si fuera suyo.
 */
export interface CondicionesComerciales {
  /** Ej. "15 días", "De contado". Es el nombre del plazo en Alegra. */
  condicionPago: string | null
  /** Días de plazo. `null` si no está cargado; 0 es "de contado". */
  plazoDias: number | null
  listaPrecios: string | null
  descuentos: { concepto: string; porcentaje: number }[]
  /** Alegra solo guarda el nombre del vendedor: teléfono y email vienen de la tabla propia. */
  vendedor: {
    nombre: string
    telefono: string | null
    email: string | null
  } | null
  transporte: {
    modalidad: string
    observaciones: string
  } | null
}

export interface SessionData {
  codigocliente?: string
  razonsocial?: string
  cuit?: string
  email?: string
  tipoCuenta?: "corriente" | "contado"
  isLoggedIn: boolean
}

export interface OtpSessionData {
  identifier?: string
  otp?: string
  otpExpiry?: number
}
