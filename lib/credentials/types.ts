// ─── Credential reference ─────────────────────────────────────────────────────
// The ONLY credential data ever stored in workflow_json or passed to the UI.
// Never contains actual credential values — only a provider identifier.

export type CredentialRef = {
  provider: string;
};

// ─── Status types ─────────────────────────────────────────────────────────────

export type CredentialStatus = 'connected' | 'missing' | 'invalid' | 'unknown';

export type CredentialSummary = {
  provider: string;
  displayName: string;
  status: CredentialStatus;
  missingFields: string[];
};

// ─── Validation result ────────────────────────────────────────────────────────

export type NodeCredentialValidation = {
  provider: string;
  connected: boolean;
  missing: string[];
};
