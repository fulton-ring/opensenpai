import { createApplication } from "../application.js";

// Local Studio owns its HTTP transport; the application only registers native tools and workflows.
const application = await createApplication(process.env, { listen: false, transport: "stdio" });
export const mastra = application.runtime.mastra;
