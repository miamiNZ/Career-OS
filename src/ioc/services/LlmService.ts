import { injectable } from "inversify";
import {
  ollamaChat,
  ollamaAvailable,
  OLLAMA_URL,
  OLLAMA_MODEL,
  type OllamaOptions,
} from "../../llm.js";

/**
 * Injectable Ollama client. Wraps the module-level `ollamaChat`/`ollamaAvailable`
 * functions (which stay exported for existing callers) behind a service so score /
 * application / search agents can depend on it via DI instead of importing directly.
 */
@injectable()
export class LlmService {
  readonly url = OLLAMA_URL;
  readonly model = OLLAMA_MODEL;

  /** True if an Ollama server is reachable and the target model is pulled. */
  available(): Promise<boolean> {
    return ollamaAvailable();
  }

  /** One-shot chat completion. Throws if Ollama is unreachable or errors. */
  chat(system: string, user: string, opts: OllamaOptions = {}): Promise<string> {
    return ollamaChat(system, user, opts);
  }
}
