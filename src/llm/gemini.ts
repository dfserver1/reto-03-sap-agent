import { redactar } from "../lib/redact";
import type {
  LlmAdapter,
  LlmMessage,
  LlmResponse,
  LlmToolDefinition,
} from "./adapter";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 30_000;
const MAX_MODELOS_INTENTOS = 4;
const MAX_MODELOS_LISTADOS = 40;

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name?: string; response?: unknown; id?: string };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string };
}

interface ErrorProveedor extends Error {
  status?: number;
  retryable?: boolean;
}

/** Modelos vigentes recomendados; el orden define la preferencia de uso. */
const MODELOS_PREDETERMINADOS = [
  "gemini-4-hydrogen",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite",
];

export class GeminiAdapter implements LlmAdapter {
  readonly name = "gemini";
  readonly determinista = false;

  private readonly apiKey: string;
  private readonly modeloPreferido: string;
  private readonly fallbacks: string[];
  private modelosCache: string[] | null;
  private modeloActual: string | null;
  private resolviendo: Promise<string[]> | null;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.modeloPreferido = (process.env.GEMINI_MODEL ?? "").trim() || "auto";
    const fallbacksConfig = (process.env.GEMINI_MODEL_FALLBACKS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.startsWith("gemini-"));
    this.fallbacks = fallbacksConfig.length > 0 ? fallbacksConfig : MODELOS_PREDETERMINADOS;
    this.modelosCache = null;
    this.modeloActual = null;
    this.resolviendo = null;
  }

  get model(): string {
    if (this.modeloActual) return this.modeloActual;
    if (this.modeloPreferido && this.modeloPreferido !== "auto") {
      return this.modeloPreferido;
    }
    return "auto";
  }

  async enviar(
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    system: string,
  ): Promise<LlmResponse> {
    const candidatos = await this.resolverModelos();
    let ultimoError: ErrorProveedor | Error | null = null;

    for (const modelo of candidatos.slice(0, MAX_MODELOS_INTENTOS)) {
      try {
        return await this.enviarConModelo(modelo, messages, tools, system);
      } catch (error) {
        ultimoError = error as ErrorProveedor;
        if (!esErrorRetryable(error)) break;
      }
    }

    const motivo = ultimoError
      ? redactar((ultimoError as Error)?.message) || "sin detalle"
      : "sin detalle";
    throw new Error(
      `No se pudo completar la solicitud con el modelo de IA (${motivo}). Revisa la configuración del proveedor.`,
    );
  }

  private async resolverModelos(): Promise<string[]> {
    if (this.modelosCache) return this.modelosCache;
    if (!this.resolviendo) {
      this.resolviendo = this.descubrirModelos().finally(() => {
        this.resolviendo = null;
      });
    }
    const lista = await this.resolviendo;
    this.modelosCache = lista;
    return lista;
  }

  private async descubrirModelos(): Promise<string[]> {
    const preferido = this.modeloPreferido.trim();
    const candidatos: string[] = [];

    const agregar = (nombre: string): void => {
      const limpio = nombre.replace(/^models\//, "").trim();
      if (!limpio) return;
      if (!/^gemini-/i.test(limpio)) return;
      if (!candidatos.some((item) => item.toLowerCase() === limpio.toLowerCase())) {
        candidatos.push(limpio);
      }
    };

    if (preferido && preferido !== "auto") {
      agregar(preferido);
      for (const fallback of this.fallbacks) {
        if (fallback.toLowerCase() !== preferido.toLowerCase()) agregar(fallback);
      }
      return candidatos;
    }

    const descubiertos = await listarModelosGemini(this.apiKey);
    for (const modelo of descubiertos) agregar(modelo);
    for (const fallback of this.fallbacks) agregar(fallback);

    return candidatos.sort((a, b) => puntuarModelo(b) - puntuarModelo(a)).slice(0, MAX_MODELOS_LISTADOS);
  }

  private async enviarConModelo(
    modelo: string,
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    system: string,
  ): Promise<LlmResponse> {
    this.modeloActual = modelo;
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
    const maxOutputTokens = Number(
      process.env.GEMINI_MAX_OUTPUT_TOKENS ?? process.env.MAX_TOKENS_SALIDA ?? 2048,
    );
    const thinkingLevel = (process.env.GEMINI_THINKING_LEVEL ?? "low").trim() || "low";

    try {
      const respuesta = await fetch(
        `${BASE_URL}/v1beta/models/${encodeURIComponent(modelo)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: messages.map((message) => this.aGemini(message)),
            tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
            generationConfig: {
              maxOutputTokens: Number.isFinite(maxOutputTokens) ? maxOutputTokens : 2048,
              thinkingConfig: { thinkingLevel },
            },
          }),
          signal: controlador.signal,
        },
      );

      const data = (await respuesta.json()) as GeminiResponse;
      if (!respuesta.ok) {
        throw crearErrorProveedor(
          `El proveedor LLM respondió ${respuesta.status}: ${data.error?.message ?? "sin detalle"}`,
          respuesta.status,
        );
      }
      if (data.promptFeedback?.blockReason) {
        throw new Error(
          `El proveedor LLM bloqueó la solicitud: ${data.promptFeedback.blockReason}`,
        );
      }

      const partes = data.candidates?.[0]?.content?.parts ?? [];
      let texto = "";
      const toolCalls: LlmResponse["toolCalls"] = [];
      for (const [indice, parte] of partes.entries()) {
        if (typeof parte.text === "string") {
          texto += parte.text;
        }
        if (parte.functionCall?.name) {
          toolCalls.push({
            id: parte.functionCall.id ?? `call_${Date.now()}_${indice}`,
            name: parte.functionCall.name,
            args: (parte.functionCall.args ?? {}) as Record<string, unknown>,
            thoughtSignature: parte.thoughtSignature,
          });
        }
      }

      const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

      return {
        text: texto.trim() || undefined,
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: data.usageMetadata?.totalTokenCount ?? inputTokens + outputTokens,
        },
      };
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        throw new Error("El proveedor LLM no respondió en 30 segundos. Intente de nuevo.");
      }
      throw error;
    } finally {
      clearTimeout(temporizador);
    }
  }

  private aGemini(message: LlmMessage): {
    role: "user" | "model" | "function";
    partes: Array<Record<string, unknown>>;
  } {
    if (message.role === "tool") {
      const contenido: Record<string, unknown> = {
        name: message.name ?? "herramienta",
        response: parsearRespuesta(message.content),
      };
      if (message.toolCallId) contenido.id = message.toolCallId;
      return { role: "function", partes: [{ functionResponse: contenido }] };
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const partes: Array<Record<string, unknown>> = [];
      if (message.content.trim()) {
        const parte: Record<string, unknown> = { text: message.content };
        const firma = message.thoughtSignature;
        if (firma) {
          parte.thought = true;
          parte.thoughtSignature = firma;
        }
        partes.push(parte);
      }
      for (const call of message.toolCalls) {
        const parte: Record<string, unknown> = {
          functionCall: {
            name: call.name,
            args: (call.args ?? {}) as Record<string, unknown>,
            ...(call.id ? { id: call.id } : {}),
          },
        };
        const firma = call.thoughtSignature ?? message.thoughtSignature;
        if (firma) {
          parte.thought = true;
          parte.thoughtSignature = firma;
        }
        partes.push(parte);
      }
      return { role: "model", partes };
    }

    const parte: Record<string, unknown> = { text: message.content };
    if (message.role === "assistant" && message.thoughtSignature) {
      parte.thought = true;
      parte.thoughtSignature = message.thoughtSignature;
    }
    const role = message.role === "assistant" ? "model" : "user";
    return { role, partes: [parte] };
  }
}

function crearErrorProveedor(mensaje: string, status?: number): ErrorProveedor {
  const error = new Error(mensaje) as ErrorProveedor;
  error.status = status;
  error.retryable = status === 404 || (status !== undefined && status >= 500);
  return error;
}

function esErrorRetryable(error: unknown): boolean {
  const err = error as ErrorProveedor;
  if (!err || typeof err !== "object" || typeof err.message !== "string") return true;
  if (err.retryable === true) return true;
  if (err.status === undefined) return true;
  if (err.status === 404) return true;
  if (err.status >= 500) return true;
  return false;
}

async function listarModelosGemini(apiKey: string): Promise<string[]> {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), 10_000);
  try {
    const respuesta = await fetch(`${BASE_URL}/models?pageSize=1000`, {
      headers: { "x-goog-api-key": apiKey },
      signal: controlador.signal,
    });
    if (!respuesta.ok) return [];
    const data = (await respuesta.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const modelos = (
      data.models ?? []
    )
      .filter(
        (modelo) =>
          typeof modelo.name === "string" &&
          modelo.supportedGenerationMethods?.includes("generateContent"),
      )
      .map((modelo) => (modelo.name ?? "").replace(/^models\//, ""))
      .filter((nombre) => /^gemini-/i.test(nombre));
    return modelos.sort((a, b) => puntuarModelo(b) - puntuarModelo(a)).slice(0, MAX_MODELOS_LISTADOS);
  } catch {
    return [];
  } finally {
    clearTimeout(temporizador);
  }
}

function puntuarModelo(nombre: string): number {
  const coincidencia = nombre.match(/^gemini-(\d+)(?:\.(\d+))?-(.*)$/i);
  if (!coincidencia) return -1;
  const major = Number(coincidencia[1]);
  const minor = Number(coincidencia[2] ?? 0);
  const familia = (coincidencia[3] ?? "").toLowerCase();
  const tier = /flash|thinking/i.test(familia) ? 200 : /pro|carbon|argon/i.test(familia) ? 100 : 50;
  const premium = /pro|carbon|argon|thinking/i.test(familia) ? 10 : 0;
  const lite = /lite/i.test(familia) ? -30 : 0;
  const preview = /preview/i.test(nombre) ? -20 : 0;
  return major * 100_000 + minor * 1_000 + tier + premium + lite + preview;
}

function parsearRespuesta(texto: string): Record<string, unknown> {
  try {
    const valor = JSON.parse(texto) as unknown;
    if (valor && typeof valor === "object" && !Array.isArray(valor)) {
      return valor as Record<string, unknown>;
    }
    return { resultado: valor };
  } catch {
    return { resultado: texto };
  }
}
