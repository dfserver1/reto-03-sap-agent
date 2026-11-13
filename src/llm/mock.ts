import type {
  LlmAdapter,
  LlmMessage,
  LlmResponse,
  LlmToolDefinition,
} from "./adapter";

export class MockAdapter implements LlmAdapter {
  readonly name = "mock";
  readonly model = "determinista";
  readonly determinista = true;

  async enviar(
    _messages: LlmMessage[],
    _tools: LlmToolDefinition[],
    _system: string,
  ): Promise<LlmResponse> {
    return {
      text: "Modo determinista: no se está consumiendo un modelo de lenguaje.",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}
