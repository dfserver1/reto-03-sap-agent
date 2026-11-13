const SECRETOS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "AZURE_CLIENT_SECRET",
  "AZURE_FABRIC_TOKEN",
  "SERPER_API_KEY",
  "COHERE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

/**
 * Reemplaza cualquier aparición de las secretos configuradas (y nombres de
 * variables conocidas) por placeholders opacos. Se usa antes de escribir logs,
 * respuestas de error o evidencias. Nunca debe exponerse el valor real.
 */
export function redactar(
  valor: string | null | undefined,
  mapa: Record<string, string | undefined> = {},
): string {
  if (!valor) return "";

  let texto = valor;
  for (const [nombre, secreto] of Object.entries(mapa)) {
    const literal = secreto?.trim();
    if (!literal) continue;
    texto = texto.split(literal).join(`[${nombre}]`);
    texto = texto.split(`${nombre}=${literal}`).join(`[${nombre}]`);
  }
  for (const nombre of SECRETOS) {
    texto = texto.split(nombre).join(`[${nombre}]`);
  }
  return texto;
}

function limpiar(valor: unknown, mapa: Record<string, string | undefined>): unknown {
  if (typeof valor === "string") return redactar(valor, mapa);
  if (Array.isArray(valor)) return valor.map((item) => limpiar(item, mapa));
  if (valor && typeof valor === "object") {
    const entrada = valor as Record<string, unknown>;
    const resultado: Record<string, unknown> = {};
    for (const [clave, contenido] of Object.entries(entrada)) {
      resultado[clave] = limpiar(contenido, mapa);
    }
    return resultado;
  }
  return valor;
}

/** Serializa JSON redactando recursivamente los valores sensibles. */
export function redactarJson(valor: unknown, mapa: Record<string, string | undefined> = {}): string {
  return JSON.stringify(limpiar(valor, mapa));
}
