import { createOpenRouterProvider } from "@opensenpai/core/providers";

/** Bundled model gateway. Native search needs its own locked workspace and key. */
export default createOpenRouterProvider({
  apiKeyEnv: "OPENROUTER_API_KEY",
  nativeSearch: {
    apiKeyEnv: "OPENROUTER_NATIVE_API_KEY",
    // This declares an operator-managed dashboard policy; it does not set or verify it.
    policy: "workspace-native-only",
  },
});
