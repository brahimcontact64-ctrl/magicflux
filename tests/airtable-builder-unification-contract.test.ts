/**
 * Phase 9.9.4B — source invariants pinning the Builder/Settings Airtable
 * credential unification and the Test Action fix, so they cannot silently
 * regress back to querying the wrong credential store or reinventing field
 * names.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROUTES_USING_CANONICAL_LOOKUP = [
  'app/api/integrations/airtable/bases/route.ts',
  'app/api/integrations/airtable/tables/route.ts',
  'app/api/integrations/airtable/fields/route.ts',
  'app/api/workflows/[id]/airtable-config/route.ts',
];

describe('Builder Airtable discovery routes use the canonical credential lookup', () => {
  for (const relPath of ROUTES_USING_CANONICAL_LOOKUP) {
    it(`${relPath} imports getConnectedAirtableToken, not getDecryptedProviderCredentials directly`, () => {
      const source = fs.readFileSync(path.join(process.cwd(), relPath), 'utf8');
      expect(source).toMatch(/getConnectedAirtableToken/);
      expect(source).not.toMatch(/getDecryptedProviderCredentials/);
    });
  }
});

describe('lifecycle.ts pre-activation Airtable gate uses the canonical lookup too', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/workflow/lifecycle.ts'), 'utf8');

  it('imports and calls getConnectedAirtableToken', () => {
    expect(source).toMatch(/getConnectedAirtableToken/);
  });

  it('no longer calls getDecryptedProviderCredentials for Airtable', () => {
    expect(source).not.toMatch(/getDecryptedProviderCredentials/);
  });
});

describe('the Airtable Test Action never invents field names or writes a record', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/integration-verifier.ts'), 'utf8');

  it('no hardcoded "Source"/"Name" test-record fields remain', () => {
    expect(source).not.toMatch(/Source:\s*['"]MagicFlux['"]/);
    expect(source).not.toMatch(/fields:\s*\{\s*Name:/);
  });

  it('the airtable create_test_record branch reuses the read-only verifyAirtable check', () => {
    const idx = source.indexOf("provider === 'airtable' && action === 'create_test_record'");
    expect(idx).toBeGreaterThan(-1);
    const section = source.slice(idx, idx + 1000);
    expect(section).toMatch(/verifyAirtable\(credentials\)/);
    expect(section).not.toMatch(/method:\s*['"]POST['"]/);
  });
});
