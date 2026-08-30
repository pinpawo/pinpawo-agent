export type RunTerminalOutcome =
  | { readonly kind: 'goal_done' }
  | {
      readonly kind: 'user_input_required';
      readonly question: string;
    }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'planner_incomplete' }
  | {
      readonly kind: 'direct_response';
      readonly source: 'capability_planner';
      readonly content: string;
    }
  | { readonly kind: 'iteration_limit' }
  | { readonly kind: 'execution_limit' }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'checkpoint_incompatible' };
