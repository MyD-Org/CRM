// Validador mínimo de JSON Schema para los tests de contratos (copias en test/contracts/, fuente
// de verdad en MyD-Org/platform/contracts). Cubre SOLO las palabras clave que usan esos schemas:
// type (object|array|string|number|integer|boolean|null), const, required, properties,
// additionalProperties:false, items, minLength, pattern, minimum, maximum, oneOf y $ref local
// (#/$defs/...). `format` se ignora (anotación en 2020-12). Si un schema nuevo usa otra palabra
// clave, se tira para no dar un "válido" falso.

type Schema = Record<string, unknown>

const SOPORTADAS = new Set([
  "$schema", "$id", "$defs", "title", "description", "format",
  "type", "const", "required", "properties", "additionalProperties", "items",
  "minLength", "pattern", "minimum", "maximum", "oneOf", "$ref",
])

function tipoDe(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number"
  return typeof v
}

export function validarJsonSchema(root: Schema, value: unknown): string[] {
  const errores: string[] = []

  const resolver = (ref: string): Schema => {
    if (!ref.startsWith("#/")) throw new Error(`$ref no soportado: ${ref}`)
    let node: unknown = root
    for (const part of ref.slice(2).split("/")) node = (node as Schema)[part]
    if (!node) throw new Error(`$ref inexistente: ${ref}`)
    return node as Schema
  }

  const visitar = (schema: Schema, v: unknown, path: string): void => {
    for (const k of Object.keys(schema)) {
      if (!SOPORTADAS.has(k)) throw new Error(`palabra clave no soportada por json-schema-lite: ${k}`)
    }
    if (typeof schema.$ref === "string") return visitar(resolver(schema.$ref), v, path)

    if (Array.isArray(schema.oneOf)) {
      const ok = (schema.oneOf as Schema[]).filter((s) => {
        const sub: string[] = []
        const antes = errores.length
        visitar(s, v, path)
        sub.push(...errores.splice(antes))
        return sub.length === 0
      }).length
      if (ok !== 1) errores.push(`${path}: oneOf coincide con ${ok} alternativas`)
      return
    }

    if ("const" in schema && v !== schema.const) errores.push(`${path}: se esperaba ${JSON.stringify(schema.const)}`)

    if (typeof schema.type === "string") {
      const t = tipoDe(v)
      const ok = schema.type === t || (schema.type === "number" && t === "integer")
      if (!ok) {
        errores.push(`${path}: tipo ${t}, se esperaba ${schema.type}`)
        return
      }
    }

    if (typeof v === "string") {
      if (typeof schema.minLength === "number" && v.length < schema.minLength) errores.push(`${path}: muy corto`)
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(v)) errores.push(`${path}: no cumple pattern`)
    }
    if (typeof v === "number") {
      if (typeof schema.minimum === "number" && v < schema.minimum) errores.push(`${path}: < minimum`)
      if (typeof schema.maximum === "number" && v > schema.maximum) errores.push(`${path}: > maximum`)
    }
    if (Array.isArray(v) && schema.items) {
      v.forEach((item, i) => visitar(schema.items as Schema, item, `${path}[${i}]`))
    }
    if (tipoDe(v) === "object") {
      const obj = v as Record<string, unknown>
      const props = (schema.properties ?? {}) as Record<string, Schema>
      for (const req of (schema.required ?? []) as string[]) {
        if (!(req in obj)) errores.push(`${path}.${req}: requerido`)
      }
      for (const [k, val] of Object.entries(obj)) {
        if (props[k]) visitar(props[k], val, `${path}.${k}`)
        else if (schema.additionalProperties === false) errores.push(`${path}.${k}: propiedad no permitida`)
      }
    }
  }

  visitar(root, value, "$")
  return errores
}
