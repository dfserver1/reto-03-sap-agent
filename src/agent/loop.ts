import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LlmAdapter, LlmMessage, LlmResponse } from "../llm/adapter";
import { registrarControl } from "../lib/audit";
import { PresupuestoAgotadoError, registrarTokens, verificarPresupuesto } from "../lib/budget";
import { redactar } from "../lib/redact";
import { formatearMoneda } from "../lib/normalize";
import {
  guardarSesion,
  type EvidenciaPendiente,
  type HerramientaEjecutada,
  type PendienteConfirmacion,
  type Sesion,
} from "../lib/session";
import { resumenPayload as resumenPayloadTexto } from "../lib/payload";
import { callTool, definicionesHerramientas } from "../tools/oc";
import type {
  ContextoHerramienta,
  OrdenCompra,
  Paquete,
  Validacion,
} from "../types/domain";

export interface ResultadoTurno {
  reply: string;
  toolCalls: HerramientaEjecutada[];
  needsConfirmation: boolean;
  pending: PendienteConfirmacion | null;
}

interface ResultadoProceso {
  reply: string;
  needsConfirmation: boolean;
}

const cachePrompt = new Map<string, string>();

export async function runTurn(
  sesion: Sesion,
  mensaje: string,
  ctx: ContextoHerramienta,
  adapter: LlmAdapter,
): Promise<ResultadoTurno> {
  const inicio = sesion.toolCalls.length;
  sesion.messages.push({ role: "user", content: mensaje });

  const contexto: ContextoHerramienta = {
    ...ctx,
    casoPermitido:
      ctx.casoPermitido ??
      detectarCaso(mensaje) ??
      sesion.pending?.caso ??
      sesion.listoParaCrear?.caso ??
      undefined,
  };

  let resultado: ResultadoProceso;
  try {
    resultado = await procesar(sesion, mensaje, contexto, adapter);
  } catch (error) {
    resultado = {
      reply: `Ocurrió un error al procesar el turno: ${redactar((error as Error).message) || "sin detalle"}. La sesión sigue activa; puedes intentar de nuevo.`,
      needsConfirmation: sesion.needsConfirmation,
    };
  }

  sesion.messages.push({ role: "assistant", content: resultado.reply });
  guardarSesion(sesion);

  return {
    reply: resultado.reply,
    toolCalls: sesion.toolCalls.slice(inicio),
    needsConfirmation: sesion.needsConfirmation,
    pending: sesion.pending ?? null,
  };
}

async function procesar(
  sesion: Sesion,
  mensaje: string,
  ctx: ContextoHerramienta,
  adapter: LlmAdapter,
): Promise<ResultadoProceso> {
  if (sesion.pending) {
    return manejarConfirmacionPendiente(sesion, mensaje, ctx);
  }

  const caso = detectarCaso(mensaje);

  if (sesion.listoParaCrear && !caso) {
    return manejarListoParaCrear(sesion, mensaje, ctx);
  }
  if (caso) {
    sesion.listoParaCrear = undefined;
  }

  if (caso && pideProcesar(mensaje)) {
    const soloValidar = pideSoloValidar(mensaje);
    if (adapter.determinista) {
      return runDeterministico(sesion, mensaje, caso, ctx, soloValidar);
    }
    try {
      return await runLlm(sesion, mensaje, caso, ctx, adapter, soloValidar);
    } catch (error) {
      const fallback = await runDeterministico(sesion, mensaje, caso, ctx, soloValidar);
      return {
        reply: `No pude usar el modelo (${redactar((error as Error).message) || "no respondió"}). Procesé el caso en modo determinista.\n\n${fallback.reply}`,
        needsConfirmation: fallback.needsConfirmation,
      };
    }
  }

  if (caso && pideSoloValidar(mensaje)) {
    if (adapter.determinista) {
      return runDeterministico(sesion, mensaje, caso, ctx, true);
    }
    try {
      return await runLlm(sesion, mensaje, caso, ctx, adapter, true);
    } catch {
      return runDeterministico(sesion, mensaje, caso, ctx, true);
    }
  }

  if (!adapter.determinista) {
    try {
      const respuesta = await adapter.enviar(sesion.messages, [], await systemPrompt(ctx.directory));
      if (respuesta.text) {
        return { reply: respuesta.text, needsConfirmation: false };
      }
    } catch {
      // Si el proveedor falla, se responde con la ayuda determinista.
    }
  }

  return { reply: ayuda(), needsConfirmation: false };
}

async function manejarConfirmacionPendiente(
  sesion: Sesion,
  mensaje: string,
  ctx: ContextoHerramienta,
): Promise<ResultadoProceso> {
  const pendiente = sesion.pending;
  if (!pendiente) return { reply: ayuda(), needsConfirmation: false };

  if (esNegativo(mensaje)) {
    sesion.pending = undefined;
    sesion.needsConfirmation = false;
    return {
      reply:
        "Entendido. No se creó la OC. La solicitud queda validada y la evidencia generada, pero sin registro en SAP.",
      needsConfirmation: false,
    };
  }

  if (esAfirmativo(mensaje)) {
    const ejecucion = await callTool(
      "oc_crear",
      { caso: pendiente.caso, payload: pendiente.orden, confirmado: true },
      ctx,
    );
    registrar(sesion, "oc_crear", { caso: pendiente.caso, confirmado: true }, ejecucion);

    if (ejecucion.parsed.ok) {
      const data = ejecucion.parsed.data as {
        numero_oc: string;
        fecha: string;
        idempotente: boolean;
        retroactiva: boolean;
      };
      sesion.pending = undefined;
      sesion.needsConfirmation = false;
      sesion.listoParaCrear = undefined;
      return {
        reply: [
          `✅ OC creada en el SAP simulado: ${data.numero_oc}`,
          `Fecha: ${data.fecha}`,
          `Retroactiva: ${data.retroactiva ? "SÍ (quedó marcada en el log de control)" : "No"}`,
          pendiente.evidencia
            ? `Evidencia: ${pendiente.evidencia.ruta} (sha256 ${pendiente.evidencia.sha256.slice(0, 12)}…)`
            : "Evidencia generada en out/.",
        ].join("\n"),
        needsConfirmation: false,
      };
    }

    sesion.pending = undefined;
    sesion.needsConfirmation = false;
    return {
      reply: `No se pudo crear la OC: ${
        ejecucion.parsed.ok ? "error desconocido" : ejecucion.parsed.error
      }. Vuelve a validar el caso para regenerar el payload.`,
      needsConfirmation: false,
    };
  }

  return {
    reply: `Tienes una confirmación pendiente para ${pendiente.caso}:\n\n${pendiente.resumen}\n\nResponde "confirmo" para crear la OC o "rechazo" para cancelarla.`,
    needsConfirmation: true,
  };
}

async function manejarListoParaCrear(
  sesion: Sesion,
  mensaje: string,
  ctx: ContextoHerramienta,
): Promise<ResultadoProceso> {
  const listo = sesion.listoParaCrear;
  if (!listo) return { reply: ayuda(), needsConfirmation: false };

  if (esNegativo(mensaje)) {
    sesion.listoParaCrear = undefined;
    return { reply: "Entendido. No se creó la OC.", needsConfirmation: false };
  }

  if (esAfirmativo(mensaje) || /\b(crea|crear|registra|registrar)\b/i.test(mensaje)) {
    const ejecucion = await callTool(
      "oc_crear",
      { caso: listo.caso, payload: listo.orden },
      ctx,
    );
    registrar(sesion, "oc_crear", { caso: listo.caso }, ejecucion);
    sesion.listoParaCrear = undefined;
    if (ejecucion.parsed.ok) {
      const data = ejecucion.parsed.data as { numero_oc: string; fecha: string };
      return {
        reply: `✅ OC creada en el SAP simulado: ${data.numero_oc}\nFecha: ${data.fecha}`,
        needsConfirmation: false,
      };
    }
    return {
      reply: `No se pudo crear la OC: ${
        ejecucion.parsed.ok ? "error desconocido" : ejecucion.parsed.error
      }`,
      needsConfirmation: false,
    };
  }

  return {
    reply: `La OC de ${listo.caso} está lista pero no se ha creado. Dime "crea la OC" para registrarla o "rechazo" para descartarla.`,
    needsConfirmation: false,
  };
}

async function runDeterministico(
  sesion: Sesion,
  mensaje: string,
  caso: string,
  ctx: ContextoHerramienta,
  soloValidar: boolean,
): Promise<ResultadoProceso> {
  const lectura = await callTool("oc_leer_paquete", { caso }, ctx);
  registrar(sesion, "oc_leer_paquete", { caso }, lectura);
  if (!lectura.parsed.ok) {
    return {
      reply: `No pude leer el paquete de ${caso}: ${lectura.parsed.error}`,
      needsConfirmation: false,
    };
  }
  const paquete = lectura.parsed.data as Paquete;

  const validacionRes = await callTool("oc_validar", { caso, paquete }, ctx);
  registrar(sesion, "oc_validar", { caso }, validacionRes);
  if (!validacionRes.parsed.ok) {
    return {
      reply: `No pude validar ${caso}: ${validacionRes.parsed.error}`,
      needsConfirmation: false,
    };
  }
  const validacion = validacionRes.parsed.data as Validacion;

  if (!validacion.apta) {
    return { reply: resumenBloqueos(validacion), needsConfirmation: false };
  }

  return completarPipeline(sesion, caso, paquete, validacion, ctx, soloValidar);
}

async function runLlm(
  sesion: Sesion,
  mensaje: string,
  caso: string,
  ctx: ContextoHerramienta,
  adapter: LlmAdapter,
  soloValidar: boolean,
): Promise<ResultadoProceso> {
  const tools = definicionesHerramientas();
  const system = await systemPrompt(ctx.directory);
  const limiteIteraciones = leerEnteroPositivo("MAX_ITERACIONES_TOOL", 25);
  const limiteTokens = leerEnteroPositivo("MAX_TOKENS_SESION", 60_000);
  const maxHerramientasPorTurno = leerEnteroPositivo("MAX_HERRAMIENTAS_POR_TURNO", 12);
  let paquete: Paquete | undefined;
  let ultimaValidacion: Validacion | undefined;
  let ultimoPayload: OrdenCompra | undefined;
  let toolCallsHechas = 0;

  for (let iteracion = 0; iteracion < limiteIteraciones; iteracion += 1) {
    if (sesion.tokensUsados >= limiteTokens) {
      return {
        reply: `Alcancé el límite de ${limiteTokens.toLocaleString(
          "es-CO",
        )} tokens configurado para esta sesión. Abre una sesión nueva o aumenta MAX_TOKENS_SESION para continuar.`,
        needsConfirmation: sesion.needsConfirmation,
      };
    }

    if (toolCallsHechas >= maxHerramientasPorTurno) {
      return {
        reply: `Alcancé el máximo de ${maxHerramientasPorTurno} herramientas por turno. La sesión sigue activa.`,
        needsConfirmation: sesion.needsConfirmation,
      };
    }

    let respuesta: LlmResponse;
    try {
      respuesta = await adapter.enviar(sesion.messages, tools, system);
    } catch (error) {
      if (error instanceof PresupuestoAgotadoError) {
        return {
          reply:
            "Alcancé el presupuesto diario de tokens del modelo. Abre una sesión nueva o aumenta MAX_TOKENS_DIA.",
          needsConfirmation: sesion.needsConfirmation,
        };
      }
      throw error;
    }
    const tokensDeEstaRespuesta =
      respuesta.usage?.totalTokens ?? estimarTokens(system, sesion.messages, respuesta.text);
    registrarTokens(tokensDeEstaRespuesta);
    sesion.tokensUsados += tokensDeEstaRespuesta;

    if (sesion.tokensUsados > limiteTokens) {
      return {
        reply: `El turno superó el límite de ${limiteTokens.toLocaleString(
          "es-CO",
        )} tokens de la sesión. Abre una sesión nueva o aumenta MAX_TOKENS_SESION para continuar.`,
        needsConfirmation: sesion.needsConfirmation,
      };
    }

    if (respuesta.toolCalls.length === 0) {
      if (toolCallsHechas === 0) {
        return runDeterministico(sesion, mensaje, caso, ctx, soloValidar);
      }
      return {
        reply: respuesta.text ?? "No pude completar la solicitud con las herramientas.",
        needsConfirmation: sesion.needsConfirmation,
      };
    }

    // El modelo nunca recibe permiso de "confirmado": la confirmación humana
    // se procesa en un turno aparte (manejarConfirmacionPendiente), donde el
    // servidor es el único que puede pasar confirmado=true.
    const calls = respuesta.toolCalls.map((call) => ({
      ...call,
      args: sanitizarArgs(call.name, call.args),
    }));

    const firmaUltima = calls
      .map((call) => call.thoughtSignature)
      .find((firma) => Boolean(firma));
    sesion.messages.push({
      role: "assistant",
      content: respuesta.text ?? "",
      toolCalls: calls,
      ...(firmaUltima ? { thoughtSignature: firmaUltima } : {}),
    });

    for (const call of calls) {
      const ejecucion = await callTool(call.name, call.args, ctx);
      registrar(sesion, call.name, call.args, ejecucion, call.id);
      toolCallsHechas += 1;

      sesion.messages.push({
        role: "tool",
        name: call.name,
        content: ejecucion.raw,
        toolCallId: call.id,
      });

      if (call.name === "oc_leer_paquete" && ejecucion.parsed.ok) {
        paquete = ejecucion.parsed.data as Paquete;
      }

      if (call.name === "oc_validar" && ejecucion.parsed.ok) {
        const validacion = ejecucion.parsed.data as Validacion;
        ultimaValidacion = validacion;
        if (!validacion.apta) {
          return { reply: resumenBloqueos(validacion), needsConfirmation: false };
        }
        const casoCall = extraerCaso(call.args) ?? caso;
        if (!paquete) {
          const lectura = await callTool("oc_leer_paquete", { caso: casoCall }, ctx);
          registrar(sesion, "oc_leer_paquete", { caso: casoCall }, lectura);
          if (lectura.parsed.ok) paquete = lectura.parsed.data as Paquete;
        }
        if (!paquete) {
          return {
            reply: "No pude recuperar el paquete para construir el payload.",
            needsConfirmation: false,
          };
        }
        return completarPipeline(sesion, casoCall, paquete, validacion, ctx, soloValidar);
      }

      if (call.name === "oc_construir_payload" && ejecucion.parsed.ok) {
        const data = ejecucion.parsed.data as { orden: OrdenCompra };
        ultimoPayload = data.orden;
      }

      if (call.name === "oc_crear" && ejecucion.parsed.ok) {
        const data = ejecucion.parsed.data as { numero_oc: string; fecha: string };
        sesion.pending = undefined;
        sesion.needsConfirmation = false;
        sesion.listoParaCrear = undefined;
        return {
          reply: `✅ OC creada en el SAP simulado: ${data.numero_oc}\nFecha: ${data.fecha}`,
          needsConfirmation: false,
        };
      }

      if (
        call.name === "oc_crear" &&
        !ejecucion.parsed.ok &&
        ejecucion.parsed.codigo === "CONFIRMACION_REQUERIDA" &&
        ultimaValidacion &&
        ultimoPayload &&
        paquete
      ) {
        const resumen = resumenConfirmaciones(ultimaValidacion, paquete);
        sesion.pending = {
          caso: extraerCaso(call.args) ?? caso,
          validacion: ultimaValidacion,
          orden: ultimoPayload,
          resumen,
        };
        sesion.needsConfirmation = true;
        return {
          reply: `La OC requiere confirmación humana:\n\n${resumen}\n\n¿Confirmas que cree la OC?`,
          needsConfirmation: true,
        };
      }
    }
  }

  return {
    reply: `Alcancé el límite de ${limiteIteraciones} iteraciones de herramientas. La sesión sigue activa; puedes pedirme que continúe con el caso o aumentar MAX_ITERACIONES_TOOL.`,
    needsConfirmation: sesion.needsConfirmation,
  };
}

async function completarPipeline(
  sesion: Sesion,
  caso: string,
  paquete: Paquete,
  validacion: Validacion,
  ctx: ContextoHerramienta,
  soloValidar: boolean,
): Promise<ResultadoProceso> {
  const payloadRes = await callTool(
    "oc_construir_payload",
    { caso, paquete, derivados: validacion.derivados },
    ctx,
  );
  registrar(sesion, "oc_construir_payload", { caso }, payloadRes);
  if (!payloadRes.parsed.ok) {
    return {
      reply: `${resumenValidacion(
        validacion,
        paquete.solicitud.moneda,
      )}\n\nNo pude construir el payload: ${payloadRes.parsed.error}`,
      needsConfirmation: false,
    };
  }

  const payloadData = payloadRes.parsed.data as {
    orden: OrdenCompra;
    trazabilidad_ruta: string;
  };
  const orden = payloadData.orden;

  const evidenciaRes = await callTool("oc_generar_evidencia", { caso }, ctx);
  registrar(sesion, "oc_generar_evidencia", { caso }, evidenciaRes);
  const evidencia = evidenciaRes.parsed.ok
    ? (evidenciaRes.parsed.data as EvidenciaPendiente)
    : undefined;

  const cabecera = [
    resumenValidacion(validacion, paquete.solicitud.moneda),
    resumenPayloadTexto(orden),
    `Trazabilidad: ${payloadData.trazabilidad_ruta}`,
  ].join("\n\n");

  if (validacion.confirmaciones.length > 0) {
    // El intento queda en control.csv aunque el humano todavía no haya
    // confirmado. Si confirma, oc_crear agregará la fila CREADA.
    await registrarControl(ctx.directory, {
      solicitud_id: paquete.solicitud.solicitud_id,
      resultado: "PENDIENTE_CONFIRMACION",
      numero_oc: "",
      retroactiva: validacion.retroactiva,
      bloqueos: "",
      confirmaciones: validacion.confirmaciones.map((item) => item.codigo).join("|"),
    });
    const resumen = resumenConfirmaciones(validacion, paquete);
    sesion.pending = { caso, validacion, orden, evidencia, resumen };
    sesion.needsConfirmation = true;
    sesion.listoParaCrear = undefined;
    return {
      reply: `${cabecera}\n\n${resumen}\n\n¿Confirmas que cree la OC?`,
      needsConfirmation: true,
    };
  }

  if (soloValidar) {
    sesion.listoParaCrear = { caso, orden, evidencia };
    sesion.needsConfirmation = false;
    return {
      reply: `${cabecera}\n\nNo creé la OC porque pediste solo validar. Dime "crea la OC" si quieres registrarla en SAP.`,
      needsConfirmation: false,
    };
  }

  const creacion = await callTool("oc_crear", { caso, payload: orden }, ctx);
  registrar(sesion, "oc_crear", { caso }, creacion);
  if (!creacion.parsed.ok) {
    return {
      reply: `${cabecera}\n\n❌ No se pudo crear la OC: ${creacion.parsed.error}`,
      needsConfirmation: false,
    };
  }

  const oc = creacion.parsed.data as {
    numero_oc: string;
    fecha: string;
    idempotente: boolean;
    retroactiva: boolean;
  };
  sesion.pending = undefined;
  sesion.needsConfirmation = false;
  sesion.listoParaCrear = undefined;

  return {
    reply: [
      cabecera,
      "",
      `✅ OC creada en el SAP simulado: ${oc.numero_oc}`,
      `Fecha: ${oc.fecha}`,
      `Idempotente: ${oc.idempotente ? "sí (ya existía)" : "no"}`,
      `Retroactiva: ${oc.retroactiva ? "SÍ (marcada en out/control.csv)" : "No"}`,
      evidencia ? `Evidencia: ${evidencia.ruta} (sha256 ${evidencia.sha256.slice(0, 12)}…)` : "",
    ]
      .filter((linea) => linea !== "")
      .join("\n"),
    needsConfirmation: false,
  };
}

function registrar(
  sesion: Sesion,
  name: string,
  args: unknown,
  ejecucion: Awaited<ReturnType<typeof callTool>>,
  id?: string,
): void {
  sesion.toolCalls.push({
    id: id ?? `det_${Date.now()}_${sesion.toolCalls.length}`,
    name,
    args,
    result: ejecucion.parsed,
    ok: ejecucion.parsed.ok,
    durationMs: ejecucion.durationMs,
  });
  if (sesion.toolCalls.length > 200) {
    sesion.toolCalls.splice(0, sesion.toolCalls.length - 200);
  }
}

function resumenBloqueos(validacion: Validacion): string {
  return [
    "❌ La solicitud no puede crear OC.",
    "",
    ...validacion.bloqueos.map(
      (bloqueo) =>
        `- ${bloqueo.codigo}: ${bloqueo.mensaje}\n  Acción sugerida: ${bloqueo.accion_sugerida}`,
    ),
  ].join("\n");
}

function resumenValidacion(
  validacion: Validacion,
  moneda: "COP" | "USD" = "COP",
): string {
  const derivados = validacion.derivados;
  const lineas = [
    "✅ La solicitud pasó los controles RC1–RC10.",
    derivados.proveedor
      ? `Proveedor: ${derivados.proveedor.nombre} (${derivados.proveedor.codigo_sap}, NIT ${derivados.proveedor.nit})`
      : "",
    derivados.aprobador
      ? `Aprobador: ${derivados.aprobador.nombre} <${derivados.aprobador.email}> — tope ${formatearMoneda(
          derivados.aprobador.tope,
        )}`
      : "",
    derivados.indicador_iva ? `IVA: ${derivados.indicador_iva}` : "",
    derivados.condiciones_pago ? `Condición de pago: ${derivados.condiciones_pago}` : "",
    derivados.unidad ? `Unidad: ${derivados.unidad}` : "",
    `Moneda: ${moneda}`,
    `Retroactiva: ${validacion.retroactiva ? "SÍ" : "No"}`,
  ];
  return lineas.filter((linea) => linea !== "").join("\n");
}

function resumenConfirmaciones(validacion: Validacion, paquete: Paquete): string {
  return [
    "⚠️ Confirmaciones requeridas antes de crear la OC:",
    ...validacion.confirmaciones.map((confirmacion) => {
      const valores = confirmacion.valores;
      let extra = "";
      if (
        valores &&
        typeof valores.valor_solicitud === "number" &&
        typeof valores.total_cotizacion === "number"
      ) {
        extra = `\n  Solicitud: ${formatearMoneda(
          valores.valor_solicitud,
          paquete.solicitud.moneda,
        )} | Cotización: ${formatearMoneda(
          valores.total_cotizacion,
          paquete.solicitud.moneda,
        )}${
          typeof valores.diferencia_pct === "number"
            ? ` | Diferencia: ${valores.diferencia_pct}%`
            : ""
        }`;
      } else if (valores && typeof valores.fecha_factura === "string") {
        extra = `\n  Factura: ${String(valores.factura ?? "")} | Fecha factura: ${
          valores.fecha_factura
        } | Fecha solicitud: ${String(valores.fecha_solicitud ?? "")}${
          typeof valores.dias_antes === "number" ? ` | Días antes: ${valores.dias_antes}` : ""
        }`;
      } else if (valores && typeof valores.codigo === "string") {
        extra = `\n  Valor propuesto: ${valores.codigo}${
          typeof valores.descripcion === "string" ? ` (${valores.descripcion})` : ""
        }`;
      }
      return `- ${confirmacion.codigo}: ${confirmacion.mensaje}${extra}`;
    }),
  ].join("\n");
}

function ayuda(): string {
  return [
    "Soy el agente de órdenes de compra de Periferia IT Group (SAP simulado).",
    "",
    "Puedo procesar los casos sol-001 a sol-006. Ejemplos:",
    '- "Procesa la solicitud sol-001"',
    '- "Valida sol-004 y muéstrame la OC sin crearla"',
    '- "Crea la OC de sol-006"',
    "",
    "En cada turno verás las llamadas a herramientas, los controles RC1–RC10 y, si aplica, una solicitud de confirmación humana.",
  ].join("\n");
}

function detectarCaso(mensaje: string): string | null {
  const match = mensaje.match(/\b(sol-\d{3})\b/i);
  return match ? match[1].toLowerCase() : null;
}

function extraerCaso(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const caso = (args as Record<string, unknown>).caso;
  return typeof caso === "string" && /^sol-\d{3}$/.test(caso) ? caso.toLowerCase() : null;
}

function pideProcesar(mensaje: string): boolean {
  return /\b(procesa|procesar|valida|validar|crea|crear|ordena|ordenar|revisa|revisar|tramita|tramitar)\b/i.test(
    mensaje,
  );
}

function pideSoloValidar(mensaje: string): boolean {
  return /\b(solo valida|solo validar|no crees|no crear|sin crear|mu[eé]strame|revisa|revisar|qu[eé] pasar[ií]a|no la crees|solo muestra)\b/i.test(
    mensaje,
  );
}

function esAfirmativo(mensaje: string): boolean {
  const texto = mensaje.trim().toLowerCase();
  if (esNegativo(texto)) return false;
  return /^(s[ií]|confirmo|confirmado|apruebo|aprobado|procede|adelante|de acuerdo|ok|dale|crea|crear|registra|registrar)\b/i.test(
    texto,
  );
}

function esNegativo(mensaje: string): boolean {
  return /^(no|rechazo|rechazado|cancela|cancelar|no crees|no crear|descarta|descartar)\b/i.test(
    mensaje.trim().toLowerCase(),
  );
}

function leerEnteroPositivo(nombre: string, porDefecto: number): number {
  const valor = Number(process.env[nombre]);
  return Number.isInteger(valor) && valor > 0 ? valor : porDefecto;
}

function sanitizarArgs(nombre: string, args: unknown): unknown {
  if (nombre !== "oc_crear") return args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  return { ...(args as Record<string, unknown>), confirmado: false };
}

function estimarTokens(
  system: string,
  messages: LlmMessage[],
  salida: string | undefined,
): number {
  const texto = [system, ...messages.map((message) => message.content), salida ?? ""].join(
    "\n",
  );
  return Math.ceil(texto.length / 4);
}

async function systemPrompt(directory: string): Promise<string> {
  const cache = cachePrompt.get(directory);
  if (cache) return cache;

  const [prompt, conocimiento] = await Promise.all([
    readFile(path.join(directory, "agent", "prompt.md"), "utf8").catch(
      () => "Eres el agente de órdenes de compra de Periferia IT Group.",
    ),
    readFile(path.join(directory, "src", "knowledge", "ordenes-compra.md"), "utf8").catch(
      () => "",
    ),
  ]);

  const completo = `${prompt}\n\n--- CONOCIMIENTO DEL PROCESO ---\n${conocimiento}`;
  cachePrompt.set(directory, completo);
  return completo;
}
