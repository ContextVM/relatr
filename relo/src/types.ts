import type { PluginCapabilitySpec } from '@contextvm/elo';

export type RelatrCapabilityArgRule = {
  requiredKeys?: string[];
  optionalKeys?: string[];
  description?: string;
  example?: unknown;
};

export type RelatrCapabilityArgValidator =
  NonNullable<PluginCapabilitySpec['validateArgs']>;

export type RelatrCapabilityDefinition = {
  name: string;
  description: string;
  argRule?: RelatrCapabilityArgRule;
  validateArgs?: RelatrCapabilityArgValidator;
  toPluginCapabilitySpec: () => PluginCapabilitySpec;
};
