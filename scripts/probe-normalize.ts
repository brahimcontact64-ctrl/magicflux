/**
 * Collision audit for normalizeProvider.
 * Runs every canonical provider name through every alias condition independently
 * to find inputs that match more than one branch.
 */
import { normalizeProvider } from '@/lib/agent/provider-allowlist';

// Define the same alias table as in the implementation so we can check each branch
type Alias = { provider: string; test: (s: string) => boolean };
const ALIAS_TABLE: Alias[] = [
  { provider: 'google_drive',   test: s => s.includes('google drive') || s.includes('googledrive') || s.includes('google-drive') || s.includes('google_drive') || s.includes('drive storage') || s.includes('save to drive') || s.includes('upload to drive') || s === 'gdrive' },
  { provider: 'google_sheets',  test: s => s.includes('google sheets') || s.includes('googlesheets') || s.includes('google-sheet') || s.includes('google_sheet') || s.includes('sheets') },
  { provider: 'facebook',       test: s => s.includes('facebook') },
  { provider: 'canva',          test: s => s.includes('canva') },
  { provider: 'openai',         test: s => s.includes('openai') || s.includes('gpt') || /\b(o1|o3|o4)\b/.test(s) },
  { provider: 'telegram',       test: s => s.includes('telegram') },
  { provider: 'reddit',         test: s => s.includes('reddit') },
  { provider: 'whatsapp',       test: s => s.includes('whatsapp') },
  { provider: 'gmail',          test: s => s.includes('emailsend') || s.includes('email') || s.includes('smtp') || s.includes('gmail') },
  { provider: 'claude',         test: s => s.includes('anthropic') || s.includes('claude') },
  { provider: 'deepgram',       test: s => s.includes('deepgram') },
  { provider: 'elevenlabs',     test: s => s.includes('elevenlabs') },
  { provider: 'airtable',       test: s => s.includes('airtable') },
  { provider: 'slack',          test: s => s.includes('slack') },
  { provider: 'hubspot',        test: s => s.includes('hubspot') },
  { provider: 'cloudflare_ai',  test: s => s.includes('cloudflare ai') || s.includes('cloudflare_ai') || s.includes('workers ai') || s.includes('workers_ai') },
  { provider: 'twitter',        test: s => s.includes('xai') || s.includes('grok') || s === 'x' || s.includes('twitter') },
  { provider: 'coinmarketcap',  test: s => s.includes('coinmarketcap') || s === 'cmc' },
  { provider: 'supabase',       test: s => s.includes('supabase') },
  { provider: 'postgres',       test: s => s.includes('postgres') },
  { provider: 'shopify',        test: s => s.includes('shopify') },
  { provider: 'stripe',         test: s => s.includes('stripe') },
];

function matchCount(s: string): Alias[] {
  return ALIAS_TABLE.filter(({ test }) => test(s.toLowerCase().trim()));
}

const compound = [
  'google-drive-shopify',
  'telegram-stripe',
  'slack-gmail-sync',
  'shopify-stripe-webhook',
  // single-provider inputs that must not collide
  'telegram',
  'telegram_api',
  'google_sheets',
  'google_drive',
  'shopify',
  'stripe',
  'slack',
  'gmail',
  'email',
  'gpt-4-turbo',
  'openai_chat',
  'cloudflare_ai_worker',
];

let anyCollision = false;
for (const s of compound) {
  const hits = matchCount(s);
  const out = normalizeProvider(s);
  if (hits.length > 1) {
    anyCollision = true;
    console.log(`COLLISION  "${s}" → "${out}"  (matched: ${hits.map(h => h.provider).join(', ')})`);
  } else {
    console.log(`OK         "${s}" → "${out}"`);
  }
}

if (!anyCollision) console.log('\nNo collisions detected.');
