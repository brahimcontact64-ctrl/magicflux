import { decryptJson, encryptJson } from '@/lib/security/encryption';
import { persistentMemory } from '@/lib/memory/persistent-memory';
import { agentOrchestrator } from '@/lib/agent/multi-agent';
import { timelineManager } from '@/lib/timeline/timeline-manager';
import { backgroundTaskManager } from '@/lib/tasks/background-task-manager';

export type SlotName =
  | 'trigger'
  | 'action'
  | 'platform'
  | 'destination'
  | 'ai_provider'
  | 'schedule'
  | 'automation_style'
  | 'business_type';

export type PlannerStatus =
  | 'collecting_requirements'
  | 'waiting_integrations'
  | 'ready_to_build'
  | 'blocked_low_confidence';

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
};

export type ConversationSlots = {
  trigger: string | null;
  action: string | null;
  platform: string | null;
  destination: string | null;
  ai_provider: string | null;
  schedule: string | null;
  automation_style: string | null;
  business_type: string | null;
};

export type AgentAnalysis = {
  assistant_message: string;
  options?: string[];
  slots: Partial<ConversationSlots>;
  confidence: number;
  planner_status: PlannerStatus;
  canonical_prompt: string;
  missing_fields: SlotName[];
  required_integrations: string[];
  ready_to_build: boolean;
};

export type ConversationState = {
  sessionId: string;
  currentGoal: string;
  detectedTrigger: string | null;
  detectedAction: string | null;
  detectedPlatform: string | null;
  requiredIntegrations: string[];
  collectedCredentials: Record<string, string>;
  missingFields: SlotName[];
  conversationHistory: ConversationMessage[];
  plannerStatus: PlannerStatus;
  slots: ConversationSlots;
  confidence: number;
  readyToBuild: boolean;
  canonicalPrompt: string;
};

// ---------------------------------------------------------------------------
// System prompt — sent to OpenAI on every conversation turn
// ---------------------------------------------------------------------------

export const CONSULTANT_SYSTEM_PROMPT = `You are NOT a consultant.

You are an autonomous AI builder and execution-first AI engineer.

Your primary role is to:
- understand the user intent
- infer architecture automatically
- infer integrations automatically
- construct workflows proactively
- execute tasks autonomously
- behave like Bolt.new + Devin + Cursor AI agents

When the user request is clear:

DO NOT explain the architecture in long-form text.

DO NOT break the request into educational sections.

DO NOT generate numbered requirement summaries.

DO NOT behave like a SaaS onboarding wizard.

Instead:
- immediately start building
- narrate actions briefly
- surface live workflow generation
- surface visual workflow progress
- generate nodes progressively
- infer defaults intelligently
- connect systems autonomously
- request credentials only when truly required

Your job is execution, not explanation.

Keep responses:
- short
- highly actionable
- alive
- conversational
- confident
- autonomous
- human-like

Avoid robotic phrasing.

Never over-explain obvious architecture decisions.

Never generate consultant-style responses.

Never ask:
- "Does this align with your vision?"
- "What would you like to start with?"
- "Should we proceed?"
- "Let''s break it down."
- "Here''s how it works."

unless the user request is ambiguous, unsafe, or technically impossible.

If the request is clear:
- immediately begin orchestration
- start generating workflow structure
- start execution narration
- show live progress naturally

Prefer:
- action over explanation
- execution over planning
- progress over discussion

Behave like a real autonomous AI engineer collaborating live with the user.Your output should always be user-facing conversational text that feels like chatting with a real AI engineer.`;

// ---------------------------------------------------------------------------
// Merge incoming slot updates from AI into existing slots
// ---------------------------------------------------------------------------

export function mergeSlots(
  current: ConversationSlots,
  incoming: Partial<ConversationSlots>
): ConversationSlots {
  const result = { ...current };
  for (const key of Object.keys(incoming) as Array<keyof ConversationSlots>) {
    const val = incoming[key];
    if (val !== undefined && val !== null && val !== '') {
      result[key] = val;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build canonical prompt from slots (used as planner input)
// ---------------------------------------------------------------------------

export function buildCanonicalPrompt(slots: ConversationSlots, goal: string): string {
  const parts: string[] = [goal || 'Build automation workflow'];
  if (slots.trigger) {
    parts.push(slots.trigger === 'schedule' && slots.schedule
      ? `Trigger: ${slots.schedule}`
      : `Trigger: ${slots.trigger}`);
  }
  if (slots.platform) parts.push(`Platform: ${slots.platform}`);
  if (slots.action) parts.push(`Action: ${slots.action}`);
  if (slots.destination) parts.push(`Destination: ${slots.destination}`);
  if (slots.ai_provider) parts.push(`AI Provider: ${slots.ai_provider}`);
  if (slots.automation_style) parts.push(`Style: ${slots.automation_style}`);
  return parts.join('. ');
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

export function providerCredentialIsValid(provider: string, value: string): boolean {
  const v = value.trim();
  if (provider === 'openai') return v.startsWith('sk-') && v.length > 20;
  if (provider === 'groq') return v.startsWith('gsk_') && v.length > 20;
  if (provider === 'claude') return v.startsWith('sk-ant-') && v.length > 20;
  return v.length > 5;
}

export function markCredential(
  existing: Record<string, unknown>,
  provider: string,
  secret: string
): Record<string, unknown> {
  const decrypted = decryptJson(existing);
  const updated = { ...decrypted, [`${provider}_connected`]: 'true' };
  return encryptJson(updated) as Record<string, unknown>;
}


