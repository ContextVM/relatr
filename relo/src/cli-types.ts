import type { RelatrPluginEvent } from "./artifact";

export type RelatrCheckResult = {
  ok: boolean;
  inputKind: "source" | "event";
  event?: RelatrPluginEvent;
  errors: string[];
};
