import { createProviderRegistry } from "@opensenpai/core/providers";
import exa from "./config/providers/exa.mjs";
import openrouter from "./config/providers/openrouter.mjs";

/** Trusted operator configuration. Agents choose models and search through MCP. */
export default {
  providers: createProviderRegistry({
    models: { openrouter },
    retrievals: { exa },
  }),
  // Optional named presets; inline MCP targets need no entry here.
  targets: [],
};
