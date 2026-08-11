import { esES } from "@clerk/localizations";

/**
 * Castellano rioplatense para los componentes de Clerk.
 *
 * `esES` es español peninsular: tutea con "tú" y trata de usted ("Regístrese",
 * "Ingrese su dirección"). En una tienda de Puerto Iguazú suena importado, y el
 * resto del sitio ya vosea. Clerk no tiene es-AR, así que se pisan solo las
 * cadenas que se ven en los flujos que usamos — el resto queda en esES.
 *
 * Sin anotación de tipo a propósito: `@clerk/types` está deprecado en Core 3 y
 * no es dependencia directa. El literal infiere solo y `ClerkProvider` lo
 * valida estructuralmente al pasarlo.
 */
export const esAR = {
  ...esES,

  formFieldLabel__emailAddress: "Correo electrónico",
  formFieldInputPlaceholder__emailAddress: "Ingresá tu correo electrónico",
  formFieldInputPlaceholder__password: "Ingresá tu contraseña",
  formFieldLabel__firstName: "Nombre",
  formFieldLabel__lastName: "Apellido",

  signIn: {
    ...esES.signIn,
    start: {
      ...esES.signIn?.start,
      title: "Ingresá",
      subtitle: "para continuar a {{applicationName}}",
      actionText: "¿No tenés cuenta?",
      actionLink: "Registrate",
    },
    password: {
      ...esES.signIn?.password,
      actionLink: "Usar otro método",
    },
  },

  signUp: {
    ...esES.signUp,
    start: {
      ...esES.signUp?.start,
      title: "Creá tu cuenta",
      subtitle: "para continuar a {{applicationName}}",
      actionText: "¿Ya tenés cuenta?",
      actionLink: "Ingresá",
    },
  },

  userButton: {
    ...esES.userButton,
    action__signOut: "Cerrar sesión",
    action__manageAccount: "Administrar cuenta",
  },
};
