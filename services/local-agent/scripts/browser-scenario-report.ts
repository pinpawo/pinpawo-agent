export type BrowserScenarioDriver = 'playwright' | 'extension';
export type BrowserScenarioPhaseKind = 'first_pass' | 'guard' | 'recovery';
export type BrowserScenarioPhaseStatus = 'passed' | 'failed' | 'skipped';
export type BrowserScenarioObservation = boolean | number | string;

export type BrowserScenarioReport = {
  schemaVersion: 1;
  driver: BrowserScenarioDriver;
  scenario: string;
  durationMs: number;
  status: 'passed' | 'failed';
  firstPass: BrowserScenarioPhaseStatus;
  recovery: BrowserScenarioPhaseStatus | 'not_applicable';
  finalErrorCode: string | null;
  observations: Record<string, BrowserScenarioObservation>;
  phases: Array<{
    name: string;
    kind: BrowserScenarioPhaseKind;
    status: BrowserScenarioPhaseStatus;
    durationMs: number;
    errorCode?: string;
    reason?: string;
  }>;
};

type Clock = () => number;

function readErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    const name = (error as { name?: unknown }).name;
    if (name === 'AssertionError') return 'assertion_failed';
  }
  return 'unexpected_error';
}

function aggregatePhaseStatus(
  phases: BrowserScenarioReport['phases'],
  kind: BrowserScenarioPhaseKind,
): BrowserScenarioPhaseStatus | 'not_applicable' {
  const matching = phases.filter((phase) => phase.kind === kind);
  if (matching.length === 0) return 'not_applicable';
  if (matching.some((phase) => phase.status === 'failed')) return 'failed';
  if (matching.every((phase) => phase.status === 'skipped')) return 'skipped';
  return 'passed';
}

/**
 * Records stable, URL-free scenario outcomes so browser driver smoke output can be
 * compared without turning a smoke test into a telemetry system.
 */
export class BrowserScenarioReporter {
  private readonly startedAt: number;
  private readonly phases: BrowserScenarioReport['phases'] = [];
  private readonly observations = new Map<string, BrowserScenarioObservation>();

  constructor(
    private readonly driver: BrowserScenarioDriver,
    private readonly scenario: string,
    private readonly now: Clock = Date.now,
  ) {
    this.startedAt = now();
  }

  async run<T>(
    name: string,
    kind: BrowserScenarioPhaseKind,
    action: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this.now();
    try {
      const value = await action();
      this.phases.push({
        name,
        kind,
        status: 'passed',
        durationMs: this.now() - startedAt,
      });
      return value;
    } catch (error) {
      this.phases.push({
        name,
        kind,
        status: 'failed',
        durationMs: this.now() - startedAt,
        errorCode: readErrorCode(error),
      });
      throw error;
    }
  }

  skip(name: string, kind: BrowserScenarioPhaseKind, reason: string): void {
    this.phases.push({ name, kind, status: 'skipped', durationMs: 0, reason });
  }

  observe(name: string, value: BrowserScenarioObservation): void {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) {
      throw new Error('browser scenario observation names must use lower camel case');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('browser scenario observations must be finite');
    }
    if (typeof value === 'string' && !/^[a-z][a-z0-9_]{0,79}$/.test(value)) {
      throw new Error('browser scenario string observations must be stable identifiers');
    }
    this.observations.set(name, value);
  }

  finish(finalError?: unknown): BrowserScenarioReport {
    const finalFailedPhase = this.phases.find((phase) => phase.status === 'failed');
    const firstPass = aggregatePhaseStatus(this.phases, 'first_pass');
    return {
      schemaVersion: 1,
      driver: this.driver,
      scenario: this.scenario,
      durationMs: this.now() - this.startedAt,
      status: finalError || finalFailedPhase ? 'failed' : 'passed',
      firstPass: firstPass === 'not_applicable' ? 'skipped' : firstPass,
      recovery: aggregatePhaseStatus(this.phases, 'recovery'),
      finalErrorCode: finalError
        ? readErrorCode(finalError)
        : finalFailedPhase?.errorCode ?? null,
      observations: Object.fromEntries(
        [...this.observations.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      phases: [...this.phases],
    };
  }
}
