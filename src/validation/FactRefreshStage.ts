import type { ValidationRunContext } from "@/validation/ValidationRunContext";
import type { FactDomain } from "@/validation/fact-dependencies";

export interface FactRefreshStageContext {
  pubkeys: string[];
  sourcePubkey?: string;
  validationRunContext?: ValidationRunContext;
  requiredFactDomains?: ReadonlySet<FactDomain>;
}

export interface FactRefreshStage {
  readonly label?: string;
  readonly factDomain?: FactDomain;
  refresh(context: FactRefreshStageContext): Promise<void>;
}

export class NoopFactRefreshStage implements FactRefreshStage {
  async refresh(_context: FactRefreshStageContext): Promise<void> {}
}

export class CompositeFactRefreshStage implements FactRefreshStage {
  readonly label = "fact refresh";

  constructor(private readonly stages: FactRefreshStage[]) {}

  async refresh(context: FactRefreshStageContext): Promise<void> {
    for (const stage of this.stages) {
      await stage.refresh(context);
    }
  }

  getStages(): FactRefreshStage[] {
    return [...this.stages];
  }
}
