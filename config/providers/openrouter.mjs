import { createOpenRouterProvider } from "@opensenpai/core/providers";

/** OpenRouter validates each requested model/search pair before paid generation. */
export default createOpenRouterProvider({ apiKeyEnv: "OPENROUTER_API_KEY" });
