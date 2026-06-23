import React from 'react';
import { ApprovalPanel } from './ApprovalPanel';
import { CommandPalette } from './CommandPalette';
import { FileMentionPopup } from './FileMentionPopup';
import { GlobalReviewPolicyPicker } from './GlobalReviewPolicyPicker';
import { ResumePicker } from './ResumePicker';
import type { TuiOverlayModel } from '../overlayModel';

export function OverlayLayer(props: {
  model: TuiOverlayModel;
}) {
  const overlay = props.model.current;
  if (!overlay) return null;

  switch (overlay.type) {
    case 'resumePicker':
      return (
        <ResumePicker
          sessions={overlay.sessions}
          selectedIndex={overlay.selectedIndex}
          loading={overlay.loading}
          width={props.model.width}
        />
      );
    case 'approval':
      return (
        <ApprovalPanel
          review={overlay.request.review}
          petId={overlay.request.petId}
          width={props.model.width}
          selectedIndex={overlay.selectedIndex}
        />
      );
    case 'globalReviewPolicyPicker':
      return (
        <GlobalReviewPolicyPicker
          currentMode={overlay.currentMode}
          selectedIndex={overlay.selectedIndex}
          width={props.model.width}
        />
      );
    case 'commandPalette':
      return <CommandPalette model={overlay.model} width={props.model.width} />;
    case 'fileMention':
      return <FileMentionPopup model={overlay.model} width={props.model.width} />;
  }
}
