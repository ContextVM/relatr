export { runCli, runCliFromProcess } from "./cli";

export {
  RELATR_PLUGIN_KIND,
  ZERO_PUBKEY,
  buildRelatrManifestTags,
  buildRelatrPluginEvent,
  canonicalizeRelatrPluginEvent,
  classifyRelatrArtifactInput,
  isRelatrPluginEvent,
  parseRelatrManifestTags,
  scaffoldRelatrPluginSource,
  stringifyRelatrPluginEvent,
  validateRelatrManifest,
  validateRelatrPluginEvent,
} from "./artifact";

export {
  RELATR_CAPABILITIES,
  RELATR_CAPABILITY_DEFINITIONS,
  RELATR_VALIDATION_CAPABILITIES,
  getRelatrCapabilityNames,
  isRelatrCapabilityName,
} from "./catalog";

export {
  validateRelatrExpressionAst,
  validateRelatrPluginProgram,
} from "./wrappers";

export type {
  RelatrCapabilityArgRule,
  RelatrCapabilityDefinition,
} from "./types";
