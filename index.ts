/**
 * @author mystery4f
 * pi-motrix — Motrix download manager tools for the Pi coding agent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerMotrixTools } from "./src/tools.js";

export default function (pi: ExtensionAPI): void {
  registerMotrixTools(pi);
}
