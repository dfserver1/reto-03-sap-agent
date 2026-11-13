import type { LlmAdapter } from "./adapter";
import { GeminiAdapter } from "./gemini";
import { MockAdapter } from "./mock";

export function crearAdapter(): LlmAdapter {
  const proveedor = (process.env.LLM_PROVIDER ?? "gemini").trim().toLowerCase();
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (proveedor === "mock" || !apiKey) {
    return new MockAdapter();
  }

  if (proveedor === "gemini") {
    return new GeminiAdapter(apiKey);
  }

  throw new Error(
    `LLM_PROVIDER="${proveedor}" no soportado. Use "gemini" o "mock".`,
  );
}
