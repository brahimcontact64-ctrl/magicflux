/**
 * Security Audit: Dev-Only E2E Session API
 * Verifies production safety before release
 */

import fs from 'fs';
import path from 'path';

const ROUTE_FILE = path.join(
  process.cwd(),
  'app/api/dev/e2e-session/route.ts'
);

const checks = {
  '1. Production runtime blocks access': false,
  '2. Production build phase blocks access': false,
  '3. No client-side env var override': false,
  '4. No token logging in code': false,
  '5. No console.log of sensitive data': false,
  '6. devOnlyGuard is first check': false,
  '7. Cleanup function removes all data': false,
  '8. DELETE requires devOnlyGuard': false,
  '9. Error messages safe': false,
};

try {
  const source = fs.readFileSync(ROUTE_FILE, 'utf8');

  // Check 1: NODE_ENV === 'production'
  if (source.includes("process.env.NODE_ENV === 'production'")) {
    checks['1. Production runtime blocks access'] = true;
  }

  // Check 2: phase-production-build
  if (source.includes("process.env.NEXT_PHASE === 'phase-production-build'")) {
    checks['2. Production build phase blocks access'] = true;
  }

  // Check 3: No NEXT_PUBLIC_* in devOnlyGuard
  const devOnlyGuardMatch = source.match(/function devOnlyGuard\(\)[\s\S]*?return null;\s*\}/);
  if (devOnlyGuardMatch) {
    const guard = devOnlyGuardMatch[0];
    if (!guard.includes('NEXT_PUBLIC_')) {
      checks['3. No client-side env var override'] = true;
    }
  }

  // Check 4: access_token not logged
  if (!source.includes('console.log(') && !source.includes('console.error(')) {
    checks['4. No token logging in code'] = true;
  }

  // Check 5: No dangerous console calls with tokens
  if (
    !source.match(/console\.(log|error|warn)\([^)]*access_token/) &&
    !source.match(/console\.(log|error|warn)\([^)]*refresh_token/)
  ) {
    checks['5. No console.log of sensitive data'] = true;
  }

  // Check 6: devOnlyGuard called first in handlers
  const postMatch = source.match(/export async function POST\(\)[\s\S]*?\{([\s\S]*?)(?:export|$)/);
  const deleteMatch = source.match(/export async function DELETE[\s\S]*?\{([\s\S]*?)(?:export|$)/);

  if (
    postMatch &&
    postMatch[1].trim().startsWith('const denied = devOnlyGuard')
  ) {
    if (
      deleteMatch &&
      deleteMatch[1].trim().startsWith('const denied = devOnlyGuard')
    ) {
      checks['6. devOnlyGuard is first check'] = true;
    }
  }

  // Check 7: Cleanup removes all associated data
  if (
    source.includes('deploy_rate_limits') &&
    source.includes('subscriptions') &&
    source.includes('user_profiles') &&
    source.includes('deleteUser')
  ) {
    checks['7. Cleanup function removes all data'] = true;
  }

  // Check 8: DELETE has guard
  if (deleteMatch && deleteMatch[1].includes('devOnlyGuard')) {
    checks['8. DELETE requires devOnlyGuard'] = true;
  }

  // Check 9: Error messages don't leak secrets
  if (
    !source.match(/error.*access_token/) &&
    !source.match(/error.*refresh_token/) &&
    !source.match(/error.*password/)
  ) {
    checks['9. Error messages safe'] = true;
  }

  console.log('\n' + '='.repeat(80));
  console.log('E2E Session API Security Audit');
  console.log('='.repeat(80));

  let allPass = true;
  for (const [check, passed] of Object.entries(checks)) {
    const status = passed ? '✓ PASS' : '✗ FAIL';
    console.log(`${status} | ${check}`);
    if (!passed) allPass = false;
  }

  console.log('='.repeat(80));

  if (allPass) {
    console.log('✓ All security checks PASSED');
    process.exit(0);
  } else {
    console.log('✗ Some security checks FAILED');
    process.exit(1);
  }
} catch (error) {
  console.error('Audit error:', error);
  process.exit(1);
}
