export type ClipboardAction = 'copy' | 'cut';

export type SelectableEditor = {
  hasSelection: () => boolean;
  getSelectedText: () => string;
  deleteSelection: () => boolean;
};

export function resolveClipboardAction(key: {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  super?: boolean;
}): ClipboardAction | null {
  const modifier = key.super || (key.ctrl && key.shift);
  if (!modifier) return null;
  if (key.name === 'c') return 'copy';
  if (key.name === 'x') return 'cut';
  return null;
}

export function applyClipboardAction(params: {
  action: ClipboardAction;
  editor: SelectableEditor;
  copy: (text: string) => boolean;
}) {
  if (!params.editor.hasSelection()) {
    return { handled: false, copied: false, cut: false };
  }
  const copied = params.copy(params.editor.getSelectedText());
  if (!copied) {
    return { handled: true, copied: false, cut: false };
  }
  const cut = params.action === 'cut'
    ? params.editor.deleteSelection()
    : false;
  return { handled: true, copied: true, cut };
}
