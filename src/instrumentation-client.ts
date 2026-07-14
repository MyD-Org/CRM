import * as Sentry from "@sentry/nextjs"

// Observabilidad de errores del cliente (browser). Gateado por NEXT_PUBLIC_SENTRY_DSN:
// sin la env var es no-op. Next ejecuta este archivo al iniciar el cliente.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    tracesSampleRate: 0,
  })
}

// Instrumenta las transiciones del router (App Router). No-op si Sentry no está inicializado.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
