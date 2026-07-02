import { useRef, useState } from 'react';
import { TUI_TEXT } from './render/text';
import type { TuiRuntimeController } from './TuiRuntimeController';
import type { WorkspaceSummary } from './types';

export type WorkspacePickerState =
  | { status: 'closed'; workspaces: WorkspaceSummary[]; selectedIndex: number }
  | { status: 'loading'; workspaces: WorkspaceSummary[]; selectedIndex: number }
  | { status: 'open'; workspaces: WorkspaceSummary[]; selectedIndex: number };

type WorkspacePickerControllerOptions = {
  ready: boolean;
  busy: boolean;
  appendSystemMessage: (text: string) => void;
  clearInputValue: () => void;
  runtimeController: Pick<TuiRuntimeController, 'listWorkspaces' | 'selectWorkspace'>;
};

export function useWorkspacePickerController(options: WorkspacePickerControllerOptions) {
  const [workspacePicker, setWorkspacePicker] = useState<WorkspacePickerState>({
    status: 'closed',
    workspaces: [],
    selectedIndex: 0,
  });
  const workspaceRequestIdRef = useRef(0);

  const closeWorkspacePicker = () => {
    workspaceRequestIdRef.current += 1;
    setWorkspacePicker((current) => ({
      status: 'closed',
      workspaces: current.workspaces,
      selectedIndex: current.selectedIndex,
    }));
  };

  const openWorkspacePicker = () => {
    if (!options.ready) {
      options.appendSystemMessage(TUI_TEXT.disconnectedCannotSend);
      return;
    }
    if (options.busy) {
      options.appendSystemMessage(TUI_TEXT.busyCannotSend);
      return;
    }
    options.clearInputValue();
    const requestId = workspaceRequestIdRef.current + 1;
    workspaceRequestIdRef.current = requestId;
    setWorkspacePicker((current) => ({
      status: 'loading',
      workspaces: current.workspaces,
      selectedIndex: current.selectedIndex,
    }));
    void options.runtimeController.listWorkspaces().then((workspaces) => {
      if (workspaceRequestIdRef.current !== requestId) return;
      const activeIndex = workspaces.findIndex((workspace) => workspace.active);
      setWorkspacePicker({
        status: 'open',
        workspaces,
        selectedIndex: Math.max(0, activeIndex),
      });
    }).catch((err) => {
      if (workspaceRequestIdRef.current !== requestId) return;
      const message = err instanceof Error ? err.message : String(err);
      setWorkspacePicker({ status: 'closed', workspaces: [], selectedIndex: 0 });
      options.appendSystemMessage(TUI_TEXT.workspaceFailed(message));
    });
  };

  const selectWorkspace = () => {
    if (workspacePicker.status !== 'open') return;
    const selected = workspacePicker.workspaces[workspacePicker.selectedIndex];
    if (!selected) {
      closeWorkspacePicker();
      options.appendSystemMessage(TUI_TEXT.workspaceEmpty);
      return;
    }
    const requestId = workspaceRequestIdRef.current + 1;
    workspaceRequestIdRef.current = requestId;
    setWorkspacePicker((current) => ({
      status: 'loading',
      workspaces: current.workspaces,
      selectedIndex: current.selectedIndex,
    }));
    void options.runtimeController.selectWorkspace(selected.id).then((result) => {
      if (workspaceRequestIdRef.current !== requestId) return;
      setWorkspacePicker({ status: 'closed', workspaces: [], selectedIndex: 0 });
      options.appendSystemMessage(
        result.requiresRestart
          ? TUI_TEXT.workspaceSavedForRestart(result.workspace.name, result.workspace.rootPath)
          : TUI_TEXT.workspaceSwitched(result.workspace.name, result.workspace.rootPath),
      );
    }).catch((err) => {
      if (workspaceRequestIdRef.current !== requestId) return;
      const message = err instanceof Error ? err.message : String(err);
      setWorkspacePicker({ status: 'closed', workspaces: [], selectedIndex: 0 });
      options.appendSystemMessage(TUI_TEXT.workspaceSelectFailed(message));
    });
  };

  const moveWorkspaceSelection = (direction: -1 | 1) => {
    setWorkspacePicker((current) => ({
      ...current,
      selectedIndex: moveWorkspaceSelectionIndex(
        current.selectedIndex,
        current.workspaces.length,
        direction,
      ),
    }));
  };

  return {
    workspacePicker,
    workspacePickerOpen: workspacePicker.status !== 'closed',
    openWorkspacePicker,
    closeWorkspacePicker,
    selectWorkspace,
    moveWorkspaceSelection,
  };
}

export function moveWorkspaceSelectionIndex(
  currentIndex: number,
  workspaceCount: number,
  direction: -1 | 1,
) {
  return direction < 0
    ? Math.max(0, currentIndex - 1)
    : Math.min(Math.max(0, workspaceCount - 1), currentIndex + 1);
}
