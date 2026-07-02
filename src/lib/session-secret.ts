// Validación fail-fast del secreto de sesión.
//
// `SESSION_SECRET` es el material criptográfico compartido de la capa de auth:
//  - password de iron-session (cookies del portal y del admin), y
//  - clave HMAC con la que se firma el `crm_token` (ver agent-token.ts).
//
// Antes había un fallback a un literal de desarrollo. En producción eso es un
// riesgo (cookies/tokens forjables con un secreto público), así que ahora se
// exige la env presente y con largo mínimo. Se evalúa al importar el módulo:
// si falta, la app NO arranca (fail-fast) — igual criterio que ai-api/src/config.ts.
//
// TODO(seguridad): separar la clave de firma HMAC del `crm_token` del password de
// iron-session (dos secretos distintos con rotación independiente). Fuera de alcance
// de este pase; hoy ambos derivan de SESSION_SECRET.

const MIN_LENGTH = 32

function requireSessionSecret(): string {
  const value = process.env.SESSION_SECRET
  if (!value || value.length < MIN_LENGTH) {
    throw new Error(
      `SESSION_SECRET is required and must be at least ${MIN_LENGTH} characters ` +
        `(got ${value ? `${value.length} chars` : "unset"}). ` +
        `Set it in the environment before starting/building the app.`,
    )
  }
  return value
}

export const SESSION_SECRET = requireSessionSecret()
