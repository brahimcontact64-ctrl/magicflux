import 'server-only';

import { sendViaGmailApi } from '@/lib/workflow-runtime/node-handlers/email';
import type { OutboundProviderClient, OutboundSendResult } from './types';

/**
 * Workflow #2 Phase B -- a thin adapter conforming the EXISTING, certified
 * Gmail send implementation (sendViaGmailApi, exported from
 * lib/workflow-runtime/node-handlers/email.ts -- Workflow #1's own email
 * node handler) to the generic OutboundProviderClient contract. This file
 * contains ZERO Gmail HTTP/MIME logic of its own -- it exists only to
 * translate one result shape into another, so send-followup.ts never needs
 * to know Gmail exists.
 */
export const gmailOutboundProviderClient: OutboundProviderClient = {
  provider: 'gmail',
  async send(params): Promise<OutboundSendResult> {
    const result = await sendViaGmailApi(params.accessToken, { to: params.to, subject: params.subject, body: params.body });
    if (result.ok) {
      return { ok: true, providerMessageId: result.id, providerThreadId: result.threadId };
    }
    if (result.indeterminate) {
      return { ok: false, indeterminate: true, message: result.message };
    }
    return { ok: false, indeterminate: false, message: result.message };
  },
};
