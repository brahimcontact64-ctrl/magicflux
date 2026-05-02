import { automationEngine } from './ai-engine';
import { EnrichedGenerationResult } from './ai-engine/types';
import { AutomationTemplate } from './templates';

export type { EnrichedGenerationResult as GenerationResult };

export async function matchTemplate(prompt: string): Promise<EnrichedGenerationResult> {
  return automationEngine.generate(prompt);
}

export async function customizeTemplate(
  prompt: string,
  current: EnrichedGenerationResult
): Promise<EnrichedGenerationResult> {
  return automationEngine.customize(prompt, current);
}

export function generateDownloadFiles(template: AutomationTemplate): {
  workflowJson: string;
  envConfig: string;
  setupGuide: string;
} {
  return {
    workflowJson: JSON.stringify(template.workflow, null, 2),
    envConfig: template.envConfig,
    setupGuide: template.setupGuide
  };
}

export function downloadFile(content: string, filename: string, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadPackage(template: AutomationTemplate) {
  const files = generateDownloadFiles(template);
  setTimeout(() => downloadFile(files.workflowJson, 'workflow.json', 'application/json'), 0);
  setTimeout(() => downloadFile(files.envConfig, '.env.example'), 200);
  setTimeout(() => downloadFile(files.setupGuide, 'README-setup.md', 'text/markdown'), 400);
}
