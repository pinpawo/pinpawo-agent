export type { TuiKeyInput } from './keyInput';
export {
  toCanonicalInputEvent,
  type CanonicalInputEvent,
} from './canonicalInput';
export {
  createInitialTuiInputBufferState,
  isTerminalControlSequence,
  isTerminalControlSequencePrefix,
  normalizeTuiInputEvent,
  type NormalizedTuiInputEvent,
  type TuiInputBufferState,
} from './terminalInput';
export {
  resolveLegacyTuiInputAction,
  resolveLegacyTuiInputAction as resolveTuiKeyAction,
  resolveTuiInputAction,
  resolveTuiInputCommand,
  resolveTuiInputOwner,
  toLegacyTuiInputCommand,
  type TuiInputCommand,
  type TuiLegacyInputCommand,
  type TuiLegacyInputCommand as TuiKeyAction,
  type TuiInputOwner,
  type TuiInputRouteContext,
  type TuiInputRouteContext as TuiKeyContext,
} from './inputRouter';
