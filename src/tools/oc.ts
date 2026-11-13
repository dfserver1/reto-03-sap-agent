import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  ContextoHerramienta,
  OrdenCompra,
  ToolResult,
} from "../types/domain";
import { leerOrdenes, registrarControl, registrarToolCall } from "../lib/audit";
import { validarPaquete } from "../lib/controls";
import { generarEvidencia, rutaOut } from "../lib/evidence";
import { leerPaquete, rutaCaso } from "../lib/fixtures";
import { cargarMaestros } from "../lib/maestros";
import { redactar } from "../lib/redact";
import { jsonCanonico } from "../lib/normalize";
import { construirOrden } from "../lib/payload";
import { SapMock } from "../sap/mock";

const CasoSchema = z
  .string()
  .regex(/^sol-\d{3}$/, "Formato esperado: sol-001")
  .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/");

// La entrada de oc_validar/oc_construir_payload se valida de forma laxa:
// el servidor relee el fixture y recalcula los derivados. El esquema fuerte
// que importa es OrdenCompraSchema, que se valida antes de crear la OC.
export const OrdenCompraSchema = z
  .object({
    referencia: z
      .object({
        solicitud_id: z.string(),
        correo_id: z.string(),
        cotizacion_ref: z.string().nullable(),
      })
      .strict(),
    sociedad: z.literal("1000"),
    organizacion_compras: z.literal("1000"),
    proveedor: z
      .object({
        codigo_sap: z.string(),
        nit: z.string(),
        nombre: z.string(),
      })
      .strict(),
    moneda: z.enum(["COP", "USD"]),
    condiciones_pago: z.string(),
    aprobador: z
      .object({
        email: z.string(),
        fecha_aprobacion: z.string(),
        evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    posiciones: z
      .array(
        z
          .object({
            numero: z.number().int().positive(),
            descripcion: z.string().min(1).max(40),
            cantidad: z.number().positive(),
            unidad: z.enum(["UN", "H", "MES"]),
            precio_unitario: z.number().nonnegative(),
            centro_costo: z.string(),
            subarea: z.string(),
            indicador_iva: z.string(),
          })
          .strict(),
      )
      .min(1),
    excepciones: z.array(
      z
        .object({
          codigo: z.string(),
          detalle: z.string(),
          confirmado_por: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export interface DefinicionHerramienta {
  description: string;
  args: Record<string, z.ZodTypeAny>;
  execute(args: Record<string, unknown>, ctx: ContextoHerramienta): Promise<string>;
}

function ok<T>(data: T): string {
  return JSON.stringify({ ok: true, data });
}

function error(mensaje: string, codigo?: string): string {
  return JSON.stringify({ ok: false, error: mensaje, ...(codigo ? { codigo } : {}) });
}

function codigos(items: Array<{ codigo: string }>): string {
  return items.map((item) => item.codigo).join("|");
}

export const leer_paquete: DefinicionHerramienta = {
  description:
    "Lee y normaliza el paquete del caso: correo, solicitud, cotización, aprobación y factura opcional.",
  args: {
    caso: CasoSchema.describe("Caso a leer, por ejemplo sol-001"),
  },
  async execute(args, ctx) {
    try {
      const { caso } = z.object({ caso: CasoSchema }).parse(args);
      const paquete = await leerPaquete(caso, ctx.directory);
      return ok(paquete);
    } catch (err) {
      return error(redactar((err as Error).message), "LECTURA");
    }
  },
};

export const validar: DefinicionHerramienta = {
  description:
    "Aplica las reglas RC1 a RC10 y devuelve apta, bloqueos, confirmaciones, derivados y retroactiva.",
  args: {
    caso: CasoSchema.describe("Caso a validar, por ejemplo sol-001"),
    paquete: z
      .record(z.string(), z.unknown())
      .describe(
        "Paquete normalizado devuelto por oc_leer_paquete. El servidor relee el fixture y no confía en los valores del modelo.",
      ),
  },
  async execute(args, ctx) {
    try {
      const { caso } = z.object({ caso: CasoSchema }).parse(args);
      // El paquete que envía el modelo no se usa como fuente de verdad:
      // se vuelve a leer del fixture para evitar alteraciones de montos o NIT.
      const paquete = await leerPaquete(caso, ctx.directory);
      const maestros = await cargarMaestros(ctx.directory);
      const validacion = validarPaquete(paquete, maestros);

      if (!validacion.apta) {
        await registrarControl(ctx.directory, {
          solicitud_id: paquete.solicitud.solicitud_id,
          resultado: "BLOQUEADA",
          numero_oc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: codigos(validacion.bloqueos),
          confirmaciones: codigos(validacion.confirmaciones),
        });
      }

      return ok(validacion);
    } catch (err) {
      return error(redactar((err as Error).message), "VALIDACION");
    }
  },
};

export const construir_payload: DefinicionHerramienta = {
  description:
    "Construye el payload OrdenCompra de la sección 7.4, lo valida con zod y guarda la trazabilidad en out/<caso>/trazabilidad.json.",
  args: {
    caso: CasoSchema.describe("Caso a construir, por ejemplo sol-001"),
    paquete: z
      .record(z.string(), z.unknown())
      .describe(
        "Paquete normalizado devuelto por oc_leer_paquete. El servidor relee el fixture y no confía en los valores del modelo.",
      ),
    derivados: z
      .record(z.string(), z.unknown())
      .describe(
        "Derivados devueltos por oc_validar. El servidor los recalcula desde los maestros.",
      ),
  },
  async execute(args, ctx) {
    try {
      const { caso } = z.object({ caso: CasoSchema }).parse(args);
      const paquete = await leerPaquete(caso, ctx.directory);
      const maestros = await cargarMaestros(ctx.directory);
      const validacion = validarPaquete(paquete, maestros);

      if (!validacion.apta) {
        return error(
          `La solicitud no es apta para OC. Bloqueos: ${codigos(validacion.bloqueos)}.`,
          "NO_APTA",
        );
      }

      const { orden, trazabilidad } = construirOrden(paquete, validacion, maestros);
      OrdenCompraSchema.parse(orden);

      const carpeta = rutaOut(ctx.directory, caso);
      await mkdir(carpeta, { recursive: true });
      const rutaTrazabilidad = path.join(carpeta, "trazabilidad.json");
      await writeFile(
        rutaTrazabilidad,
        JSON.stringify(
          {
            caso,
            generado_en: new Date().toISOString(),
            trazabilidad,
            orden,
          },
          null,
          2,
        ),
        "utf8",
      );

      const relativa = path.relative(ctx.directory, rutaTrazabilidad);
      return ok({
        orden,
        trazabilidad_ruta: relativa.startsWith("..") ? rutaTrazabilidad : relativa,
        derivados: validacion.derivados,
      });
    } catch (err) {
      return error(redactar((err as Error).message), "PAYLOAD");
    }
  },
};

export const generar_evidencia: DefinicionHerramienta = {
  description:
    "Genera la evidencia de aprobación en out/<caso>/aprobacion.txt (P0) y opcionalmente .pdf (P1), y devuelve su sha256.",
  args: {
    caso: CasoSchema.describe("Caso del que se genera la evidencia, por ejemplo sol-001"),
  },
  async execute(args, ctx) {
    try {
      const { caso } = z.object({ caso: CasoSchema }).parse(args);
      const paquete = await leerPaquete(caso, ctx.directory);
      if (!paquete.aprobacion) {
        return error(redactar("El caso no tiene aprobacion.json; no se puede generar evidencia."), "SIN_APROBACION");
      }
      const evidencia = await generarEvidencia(ctx.directory, caso, paquete.aprobacion);
      return ok(evidencia);
    } catch (err) {
      return error((err as Error).message, "EVIDENCIA");
    }
  },
};

export const crear: DefinicionHerramienta = {
  description:
    "Crea la OC en el SAP simulado si la solicitud es apta y, cuando hay confirmaciones, si el usuario confirmó explícitamente. Es idempotente por solicitud_id.",
  args: {
    caso: CasoSchema.describe("Caso a crear, por ejemplo sol-001"),
    payload: OrdenCompraSchema.describe("Payload exacto devuelto por oc_construir_payload"),
    confirmado: z
      .boolean()
      .optional()
      .describe("true solo si el usuario confirmó explícitamente las excepciones"),
  },
  async execute(args, ctx) {
    try {
      const { caso, payload, confirmado } = z
        .object({
          caso: CasoSchema,
          payload: OrdenCompraSchema,
          confirmado: z.boolean().optional(),
        })
        .parse(args);

      await rutaCaso(ctx.directory, caso);
      const paquete = await leerPaquete(caso, ctx.directory);
      const maestros = await cargarMaestros(ctx.directory);
      const validacion = validarPaquete(paquete, maestros);

      if (!validacion.apta) {
        await registrarControl(ctx.directory, {
          solicitud_id: paquete.solicitud.solicitud_id,
          resultado: "BLOQUEADA",
          numero_oc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: codigos(validacion.bloqueos),
          confirmaciones: codigos(validacion.confirmaciones),
        });
        return error(
          `La solicitud está bloqueada: ${validacion.bloqueos
            .map((bloqueo) => `${bloqueo.codigo} ${bloqueo.mensaje}`)
            .join(" | ")}`,
          "BLOQUEADA",
        );
      }

      if (validacion.confirmaciones.length > 0 && !confirmado) {
        await registrarControl(ctx.directory, {
          solicitud_id: paquete.solicitud.solicitud_id,
          resultado: "PENDIENTE_CONFIRMACION",
          numero_oc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: "",
          confirmaciones: codigos(validacion.confirmaciones),
        });
        return error(
          `La OC requiere confirmación humana: ${validacion.confirmaciones
            .map((confirmacion) => `${confirmacion.codigo} ${confirmacion.mensaje}`)
            .join(" | ")}`,
          "CONFIRMACION_REQUERIDA",
        );
      }

      const existente = await new SapMock(ctx.directory).buscarOrdenPorReferencia(
        paquete.solicitud.solicitud_id,
      );
      if (existente) {
        await registrarControl(ctx.directory, {
          solicitud_id: paquete.solicitud.solicitud_id,
          resultado: "CREADA",
          numero_oc: existente.numero_oc,
          retroactiva: validacion.retroactiva,
          bloqueos: "",
          confirmaciones: codigos(validacion.confirmaciones),
        });
        const original = (await leerOrdenes(ctx.directory)).find(
          (item) => item.orden.referencia.solicitud_id === paquete.solicitud.solicitud_id,
        );
        return ok({
          numero_oc: existente.numero_oc,
          fecha: original?.fecha ?? new Date().toISOString(),
          idempotente: true,
          retroactiva: validacion.retroactiva,
        });
      }

      const { orden: esperado } = construirOrden(paquete, validacion, maestros);
      OrdenCompraSchema.parse(esperado);

      const normalizar = (orden: OrdenCompra): OrdenCompra => ({
        ...orden,
        excepciones: orden.excepciones.map((excepcion) => ({
          ...excepcion,
          confirmado_por: null,
        })),
      });

      if (jsonCanonico(normalizar(payload)) !== jsonCanonico(normalizar(esperado))) {
        return error(
          "El payload no coincide con la validación del servidor. Vuelva a ejecutar oc_construir_payload; no altere montos, proveedor ni posiciones.",
          "PAYLOAD_ALTERADO",
        );
      }

      const evidencia = await generarEvidencia(ctx.directory, caso, paquete.aprobacion!);
      if (evidencia.sha256 !== esperado.aprobador.evidencia_sha256) {
        return error(
          "El hash de la evidencia de aprobación no coincide con el payload. Vuelva a construir el payload.",
          "EVIDENCIA_INCONSISTENTE",
        );
      }

      const ordenFinal: OrdenCompra = {
        ...esperado,
        excepciones: esperado.excepciones.map((excepcion) => ({
          ...excepcion,
          confirmado_por: confirmado ? "analista" : null,
        })),
      };

      const creada = await new SapMock(ctx.directory).crearOrden(ordenFinal);
      await registrarControl(ctx.directory, {
        solicitud_id: paquete.solicitud.solicitud_id,
        resultado: "CREADA",
        numero_oc: creada.numero_oc,
        retroactiva: validacion.retroactiva,
        bloqueos: "",
        confirmaciones: codigos(validacion.confirmaciones),
      });

      return ok({
        numero_oc: creada.numero_oc,
        fecha: creada.fecha,
        idempotente: false,
        retroactiva: validacion.retroactiva,
        evidencia_sha256: ordenFinal.aprobador.evidencia_sha256,
        evidencia_ruta: evidencia.ruta,
      });
    } catch (err) {
      return error(redactar((err as Error).message), "CREACION");
    }
  },
};

export const tools = {
  oc_leer_paquete: leer_paquete,
  oc_validar: validar,
  oc_construir_payload: construir_payload,
  oc_generar_evidencia: generar_evidencia,
  oc_crear: crear,
} as const;

export type ToolName = keyof typeof tools;

export function esToolName(nombre: string): nombre is ToolName {
  return nombre in tools;
}

export function definicionesHerramientas(): Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return Object.entries(tools).map(([name, tool]) => {
    // Se ensancha el tipo para evitar que TypeScript expanda la unión de
    // esquemas de todas las herramientas (instantiation excessively deep).
    const argsSchema: Record<string, z.ZodTypeAny> = tool.args;
    const schema: z.ZodTypeAny = z.object(argsSchema).strict();
    const json = convertirAJsonSchema(schema, {
      target: "openApi3",
      $refStrategy: "none",
    });
    return {
      name,
      description: tool.description,
      parameters: limpiarSchema(json) as Record<string, unknown>,
    };
  });
}

const convertirAJsonSchema = zodToJsonSchema as unknown as (
  schema: z.ZodTypeAny,
  opciones: { target: "openApi3"; $refStrategy: "none" },
) => Record<string, unknown>;

function limpiarSchema(valor: unknown): unknown {
  if (Array.isArray(valor)) {
    return valor.map(limpiarSchema);
  }
  if (valor && typeof valor === "object") {
    const objeto = valor as Record<string, unknown>;
    const resultado: Record<string, unknown> = {};
    for (const [clave, contenido] of Object.entries(objeto)) {
      if (clave === "$schema" || clave === "additionalProperties") continue;
      resultado[clave] = limpiarSchema(contenido);
    }
    return resultado;
  }
  return valor;
}

export interface ResultadoTool {
  raw: string;
  parsed: ToolResult<unknown>;
  durationMs: number;
}

export async function callTool(
  nombre: string,
  args: unknown,
  ctx: ContextoHerramienta,
): Promise<ResultadoTool> {
  const inicio = Date.now();

  if (!esToolName(nombre)) {
    const raw = error(`Herramienta desconocida: "${nombre}".`, "TOOL_DESCONOCIDA");
    return {
      raw,
      parsed: JSON.parse(raw) as ToolResult<unknown>,
      durationMs: Date.now() - inicio,
    };
  }

  const tool = tools[nombre];

  const argsNormalizados =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const casoEnArgs =
    typeof argsNormalizados.caso === "string" &&
    /^sol-\d{3}$/i.test(argsNormalizados.caso)
      ? argsNormalizados.caso.toLowerCase()
      : null;
  const contextoBloqueado =
    ctx.casoPermitido && casoEnArgs && casoEnArgs !== ctx.casoPermitido;

  const schema = z.object(tool.args).strict();
  const validacion = schema.safeParse(args);
  if (!validacion.success) {
    const detalle = validacion.error.issues
      .map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`)
      .join("; ");
    const raw = error(`Argumentos inválidos para ${nombre}: ${detalle}`, "ARGS");
    await registrarToolCall(ctx.directory, ctx.sessionId, nombre, args, JSON.parse(raw), Date.now() - inicio);
    return {
      raw,
      parsed: JSON.parse(raw) as ToolResult<unknown>,
      durationMs: Date.now() - inicio,
    };
  }

  if (contextoBloqueado) {
    const rawBloqueado = error(
      `La herramienta ${nombre} solo puede usarse para el caso ${ctx.casoPermitido}.`,
      "CASO_NO_PERMITIDO",
    );
    await registrarToolCall(ctx.directory, ctx.sessionId, nombre, args, JSON.parse(rawBloqueado), Date.now() - inicio);
    return {
      raw: rawBloqueado,
      parsed: JSON.parse(rawBloqueado) as ToolResult<unknown>,
      durationMs: Date.now() - inicio,
    };
  }

  let raw: string;
  try {
    raw = await tool.execute(validacion.data as Record<string, unknown>, ctx);
  } catch (err) {
    raw = error((err as Error).message, "TOOL");
  }

  let parsed: ToolResult<unknown>;
  try {
    parsed = JSON.parse(raw) as ToolResult<unknown>;
  } catch {
    raw = error("La herramienta devolvió una respuesta no serializable.", "TOOL");
    parsed = JSON.parse(raw) as ToolResult<unknown>;
  }

  const durationMs = Date.now() - inicio;
  await registrarToolCall(ctx.directory, ctx.sessionId, nombre, validacion.data, parsed, durationMs);

  return { raw, parsed, durationMs };
}
