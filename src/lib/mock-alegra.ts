import type { AlegraCategory, AlegraProduct } from "./alegra"

// Fixtures para desarrollo sin credenciales de Alegra (alegraMock=true). Sirven tanto para la
// sync (poblar la cache) como para el endpoint live (precio/stock al momento). Ver ADR catálogo.

export const mockCategories: AlegraCategory[] = [
  { alegraId: "cat-led", name: "Iluminación LED", parentAlegraId: null, status: "active" },
  { alegraId: "cat-paneles", name: "Paneles y plafones", parentAlegraId: "cat-led", status: "active" },
  { alegraId: "cat-reflectores", name: "Reflectores", parentAlegraId: "cat-led", status: "active" },
  { alegraId: "cat-cables", name: "Cables", parentAlegraId: null, status: "active" },
  { alegraId: "cat-tableros", name: "Tableros y protección", parentAlegraId: null, status: "active" },
]

// Precios con dos listas (público / mayorista) para ejercitar el diseño flexible de varias listas.
function prices(publico: number, mayorista: number): AlegraProduct["prices"] {
  return [
    { idPriceList: "1", name: "Público", price: publico },
    { idPriceList: "2", name: "Mayorista", price: mayorista },
  ]
}

export const mockItems: AlegraProduct[] = [
  { alegraId: "it-1", code: "LED-12W-FRIA", name: "Lámpara LED 12W E27 luz fría", description: "Bajo consumo, 6500K", categoryAlegraId: "cat-led", prices: prices(1890, 1490), stock: 240, status: "active", images: [] },
  { alegraId: "it-2", code: "LED-9W-CALIDA", name: "Lámpara LED 9W E27 luz cálida", description: "3000K", categoryAlegraId: "cat-led", prices: prices(1590, 1250), stock: 180, status: "active", images: [] },
  { alegraId: "it-3", code: "PANEL-18W", name: "Panel LED 18W embutir redondo", description: "Plafón 22cm", categoryAlegraId: "cat-paneles", prices: prices(4290, 3490), stock: 60, status: "active", images: [] },
  { alegraId: "it-4", code: "PANEL-48W", name: "Panel LED 48W 60x60 embutir", description: "Para cielorraso desmontable", categoryAlegraId: "cat-paneles", prices: prices(11900, 9900), stock: 25, status: "active", images: [] },
  { alegraId: "it-5", code: "REFL-50W", name: "Reflector LED 50W exterior IP65", description: "Luz fría, alta potencia", categoryAlegraId: "cat-reflectores", prices: prices(9800, 7900), stock: 40, status: "active", images: [] },
  { alegraId: "it-6", code: "REFL-100W", name: "Reflector LED 100W exterior IP65", description: "Para canchas y playas de estacionamiento", categoryAlegraId: "cat-reflectores", prices: prices(18900, 15500), stock: 12, status: "active", images: [] },
  { alegraId: "it-7", code: "CAB-TALLER-2X075", name: "Cable taller 2x0.75mm (rollo 100m)", description: "Flexible, envainado", categoryAlegraId: "cat-cables", prices: prices(34500, 29900), stock: 8, status: "active", images: [] },
  { alegraId: "it-8", code: "CAB-UNIP-2.5", name: "Cable unipolar 2.5mm (rollo 100m)", description: "Norma IRAM", categoryAlegraId: "cat-cables", prices: prices(41200, 35800), stock: 15, status: "active", images: [] },
  { alegraId: "it-9", code: "TERM-2X16", name: "Termomagnética 2x16A", description: "Curva C", categoryAlegraId: "cat-tableros", prices: prices(8700, 6900), stock: 50, status: "active", images: [] },
  { alegraId: "it-10", code: "DISY-2X25-30MA", name: "Disyuntor 2x25A 30mA", description: "Protección diferencial", categoryAlegraId: "cat-tableros", prices: prices(16400, 13200), stock: 22, status: "active", images: [] },
]

const itemsById = new Map(mockItems.map((it) => [it.alegraId, it]))

/** Versión "en vivo" de un ítem del mock. Aplica un pequeño override opcional (process-local) para
 *  poder demostrar que el live difiere de la cache (ver ADR / verificación). */
const liveOverrides = new Map<string, Partial<AlegraProduct>>()
export function __setMockLiveOverride(alegraId: string, patch: Partial<AlegraProduct>) {
  liveOverrides.set(alegraId, patch)
}

export function getMockItemLive(alegraId: string): AlegraProduct | null {
  const base = itemsById.get(alegraId)
  if (!base) return null
  const patch = liveOverrides.get(alegraId)
  return patch ? { ...base, ...patch } : base
}
