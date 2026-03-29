import type { RelatrPluginEvent } from "./artifact.js";

export type RelatrCheckResult = {
  ok: boolean;
  inputKind: "source" | "event";
  event?: RelatrPluginEvent;
  errors: string[];
};
