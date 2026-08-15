import { createContext } from 'react';

export interface WorkflowEditorContextValue {
  onRenameNode: (id: string, newName: string) => void;
  onDeleteNode: (id: string) => void;
  onUpdateNodeParameters: (id: string, parameters: Record<string, unknown>) => void;
}

export const WorkflowEditorContext = createContext<WorkflowEditorContextValue>({
  onRenameNode: () => {},
  onDeleteNode: () => {},
  onUpdateNodeParameters: () => {},
});
