import { secureCompare } from "@/lib/secure-compare"
import { getTenantConfig } from "@/lib/tenant-context"

// Destino del redirect del Embedded Signup de Meta al conectar el WhatsApp real de un
// tenant con Coexistence. Vive en el CRM (y no en la ai-api) porque Meta exige que el
// redirect_uri esté en un dominio registrado en la app, y este ya lo está: es el mismo
// de las páginas legales. La ai-api no queda expuesta a internet.
//
// Es PÚBLICA (excluida del site gate en proxy.ts): la abre el dueño del número desde su
// navegador, que no tiene sesión del CRM. Lo que la protege es el `state`: un secreto que
// viaja en el link de onboarding y que solo conoce quien lo armó. Sin eso, cualquiera con
// el link podría conectar SU número y pisar la config de producción del tenant.
//
// El canje del code lo hace la ai-api (tiene la ENCRYPTION_KEY y la DB de channel_accounts);
// acá solo se valida el state y se reenvía server-to-server con INTERNAL_SECRET.
export const dynamic = "force-dynamic"

interface OnboardingResult {
  ok?: boolean
  tenantName?: string
  wabaId?: string
  phoneNumberId?: string
  displayPhoneNumber?: string | null
  verifiedName?: string | null
  channelAccountId?: string
  subscribedApps?: boolean
  error?: string
  detail?: string
}

async function completeOnboarding(code: string): Promise<{ result: OnboardingResult; failed: boolean }> {
  const tenant = await getTenantConfig()
  if (!tenant.aiApiBaseUrl) {
    return { result: { detail: "El tenant no tiene aiApiBaseUrl configurada." }, failed: true }
  }

  try {
    const res = await fetch(`${tenant.aiApiBaseUrl.replace(/\/$/, "")}/onboarding/whatsapp-coexistence/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.INTERNAL_SECRET ?? ""}`,
      },
      body: JSON.stringify({ code }),
      cache: "no-store",
    })
    const body = (await res.json()) as OnboardingResult
    return { result: body, failed: !res.ok }
  } catch (err) {
    console.error("onboarding whatsapp: no se pudo llamar a ai-api", err)
    return { result: { detail: "No se pudo contactar al servicio de mensajería." }, failed: true }
  }
}

export default async function WhatsAppOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

  const state = first(params.state)
  const code = first(params.code)
  const metaError = first(params.error)
  const metaErrorDescription = first(params.error_description)

  const stateSecret = process.env.WA_ONBOARD_STATE_SECRET
  if (!stateSecret || !state || !secureCompare(state, stateSecret)) {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-red-700">Enlace no válido</h1>
        <p className="mt-3 text-slate-600">
          Este enlace no es válido o ya expiró. Pedí uno nuevo a quien te lo compartió.
        </p>
      </Shell>
    )
  }

  if (metaError) {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-red-700">Conexión cancelada</h1>
        <p className="mt-3 text-slate-600">
          No se completó la conexión con WhatsApp{metaErrorDescription ? `: ${metaErrorDescription}` : "."}
        </p>
        <p className="mt-3 text-slate-600">Podés volver a abrir el enlace para intentarlo de nuevo.</p>
      </Shell>
    )
  }

  if (!code) {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-slate-800">Nada que hacer acá</h1>
        <p className="mt-3 text-slate-600">
          Esta página es el último paso de la conexión de WhatsApp. Se abre sola al terminar ese proceso.
        </p>
      </Shell>
    )
  }

  const { result, failed } = await completeOnboarding(code)

  if (failed || !result.ok) {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-red-700">No se pudo completar</h1>
        <p className="mt-3 text-slate-600">
          La conexión con Meta se hizo, pero falló el último paso de nuestro lado. El código de autorización dura
          pocos minutos, así que conviene reintentar desde el enlace original.
        </p>
        {result.detail ? (
          <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
            {result.detail}
          </pre>
        ) : null}
      </Shell>
    )
  }

  return (
    <Shell>
      <h1 className="text-2xl font-bold text-green-700">WhatsApp conectado</h1>
      <p className="mt-3 text-slate-600">
        El número quedó conectado y la app de WhatsApp Business del celular sigue funcionando igual.
      </p>
      <dl className="mt-6 space-y-2 text-sm">
        <Row label="Negocio" value={result.verifiedName ?? result.tenantName} />
        <Row label="Número" value={result.displayPhoneNumber} />
        <Row label="Cuenta de WhatsApp" value={result.wabaId} />
        <Row label="Recepción de mensajes" value={result.subscribedApps ? "activada" : "⚠️ falló — avisá al equipo"} />
      </dl>
      <p className="mt-6 text-slate-600">
        Ya podés cerrar esta ventana. Para probarlo, escribile un mensaje al número desde otro teléfono.
      </p>
    </Shell>
  )
}

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <dt className="font-semibold text-slate-700">{label}:</dt>
      <dd className="text-slate-600">{value}</dd>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">{children}</div>
    </main>
  )
}
