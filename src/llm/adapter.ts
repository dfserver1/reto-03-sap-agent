export interface LlmToolCall {
  id: string;
  name: string;
  args: unknown;
  /** Firma de pensamiento de los modelos Gemini 3+ para continuar razonamiento. */
  thoughtSignature?: string;
}

export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
  /** Firma de pensamiento asociada al turno del asistente (Gemini 3+). */
  thoughtSignature?: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  text?: string;
  toolCalls: LlmToolCall[];
  usage?: LlmUsage;
}

export interface LlmAdapter {
  readonly name: string;
  readonly model: string;
  readonly determinista: boolean;
  enviar(
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    system: string,
  ): Promise<LlmResponse>;
}
