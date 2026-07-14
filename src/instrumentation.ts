import * as Sentry from "@sentry/nextjs"

// Observabilidad de errores del server (API routes + Server Components). Gateado por
// SENTRY_DSN: sin la env var es no-op (dev/local, o hasta crear la cuenta de Sentry).
// Next llama register() una vez al iniciar cada instancia del server.
export async function register() {
  if (!process.env.SENTRY_DSN) return
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      // Solo errores por ahora (sin tracing/performance).
      tracesSampleRate: 0,
    })
  }
}

// Captura errores de requests (rutas / RSC). No-op si Sentry no está inicializado.
export const onRequestError = Sentry.captureRequestError
