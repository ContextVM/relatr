import {
  validateExpressionAst,
  validatePluginProgram,
  type Expr,
  type PluginValidationOptions,
  type ValidatedPluginProgram,
  type PluginDiagnostic,
} from "@contextvm/elo";

import { RELATR_VALIDATION_CAPABILITIES } from "./catalog";

export function validateRelatrPluginProgram(
  source: string,
  options: Omit<PluginValidationOptions, "capabilities"> = {},
): ValidatedPluginProgram {
  return validatePluginProgram(source, {
    ...options,
    capabilities: RELATR_VALIDATION_CAPABILITIES,
  });
}

export function validateRelatrExpressionAst(
  expr: Expr,
  options: Omit<PluginValidationOptions, "capabilities"> = {},
): PluginDiagnostic[] {
  return validateExpressionAst(expr, {
    ...options,
    capabilities: RELATR_VALIDATION_CAPABILITIES,
  });
}
