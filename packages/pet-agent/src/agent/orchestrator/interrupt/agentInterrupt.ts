export interface AgentInterrupt<TInteraction, TTransition> {
  readonly kind: string;

  interaction(): TInteraction;
  resume(value: unknown): TTransition | Promise<TTransition>;
}
