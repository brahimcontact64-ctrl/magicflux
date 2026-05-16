-- ============================================================================
-- PHASE 17: AUTOMATION KNOWLEDGE BRAIN + CAPABILITY ENGINE + SKILL PACKS
-- ============================================================================

CREATE TABLE IF NOT EXISTS capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL,
  provider_examples text[] NOT NULL DEFAULT '{}',
  category text NOT NULL DEFAULT 'general',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text NOT NULL,
  description text NOT NULL,
  intent_keywords text[] NOT NULL DEFAULT '{}',
  required_tools text[] NOT NULL DEFAULT '{}',
  optional_tools text[] NOT NULL DEFAULT '{}',
  required_capabilities text[] NOT NULL DEFAULT '{}',
  workflow_structure jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk text NOT NULL DEFAULT 'medium',
  estimated_cost numeric(12,4) NOT NULL DEFAULT 0,
  estimated_complexity text NOT NULL DEFAULT 'moderate',
  schedule_patterns text[] NOT NULL DEFAULT '{}',
  industry text NOT NULL DEFAULT 'general',
  examples text[] NOT NULL DEFAULT '{}',
  popularity_score integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_patterns_risk_check CHECK (risk IN ('low', 'medium', 'high')),
  CONSTRAINT automation_patterns_complexity_check CHECK (estimated_complexity IN ('simple', 'moderate', 'complex'))
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_patterns_name_unique_idx
  ON automation_patterns (lower(name));

CREATE INDEX IF NOT EXISTS automation_patterns_category_idx
  ON automation_patterns (category);

CREATE INDEX IF NOT EXISTS automation_patterns_industry_idx
  ON automation_patterns (industry);

CREATE INDEX IF NOT EXISTS automation_patterns_keywords_idx
  ON automation_patterns USING gin (intent_keywords);

CREATE INDEX IF NOT EXISTS automation_patterns_capabilities_idx
  ON automation_patterns USING gin (required_capabilities);

CREATE TABLE IF NOT EXISTS skill_packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL,
  tools text[] NOT NULL DEFAULT '{}',
  capabilities text[] NOT NULL DEFAULT '{}',
  patterns text[] NOT NULL DEFAULT '{}',
  activation_keywords text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id text,
  workflow_id text,
  prompt text NOT NULL,
  generated_workflow jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_pattern text,
  success_rate numeric(5,2),
  runtime_performance jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_edits jsonb NOT NULL DEFAULT '{}'::jsonb,
  feedback_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_feedback_user_idx
  ON workflow_feedback (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_feedback_workflow_idx
  ON workflow_feedback (workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_feedback_prompt_idx
  ON workflow_feedback USING gin (to_tsvector('english', prompt));

ALTER TABLE capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read capabilities" ON capabilities;
CREATE POLICY "Public read capabilities" ON capabilities
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read automation patterns" ON automation_patterns;
CREATE POLICY "Public read automation patterns" ON automation_patterns
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read skill packs" ON skill_packs;
CREATE POLICY "Public read skill packs" ON skill_packs
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can access own workflow feedback" ON workflow_feedback;
CREATE POLICY "Users can access own workflow feedback" ON workflow_feedback
  FOR ALL USING (auth.uid() = user_id);

-- Seed capability catalog
INSERT INTO capabilities (key, name, description, provider_examples, category)
VALUES
  ('send_message', 'Send Message', 'Send outbound messages to users or channels.', ARRAY['telegram', 'discord', 'slack', 'whatsapp'], 'messaging'),
  ('receive_message', 'Receive Message', 'Ingest inbound user messages or events.', ARRAY['telegram', 'whatsapp', 'discord', 'webhook'], 'messaging'),
  ('speech_to_text', 'Speech To Text', 'Transcribe voice/audio into text.', ARRAY['openai', 'deepgram', 'assemblyai'], 'voice'),
  ('text_to_speech', 'Text To Speech', 'Generate spoken audio from text.', ARRAY['elevenlabs', 'openai', 'azure_tts'], 'voice'),
  ('vision_analysis', 'Vision Analysis', 'Extract meaning from images or video frames.', ARRAY['openai_vision', 'grok_vision', 'google_vision'], 'vision'),
  ('memory', 'Memory', 'Store and retrieve short and long-term context.', ARRAY['supabase', 'redis', 'postgres'], 'ai'),
  ('database_storage', 'Database Storage', 'Persist records and logs.', ARRAY['supabase', 'postgres', 'airtable'], 'data'),
  ('vector_search', 'Vector Search', 'Index and query embeddings for semantic retrieval.', ARRAY['pgvector', 'pinecone', 'weaviate'], 'ai'),
  ('scheduling', 'Scheduling', 'Run jobs on recurring or timed schedules.', ARRAY['cron', 'n8n_schedule', 'temporal'], 'orchestration'),
  ('payment', 'Payment', 'Handle payment events and payment actions.', ARRAY['stripe', 'paypal', 'shopify'], 'commerce'),
  ('email_send', 'Email Send', 'Send transactional or campaign email.', ARRAY['smtp', 'gmail', 'sendgrid'], 'messaging'),
  ('scraping', 'Scraping', 'Collect web content from pages or APIs.', ARRAY['http', 'browser', 'crawler'], 'data'),
  ('search', 'Search', 'Find records, pages, users, or entities.', ARRAY['reddit', 'google', 'internal_index'], 'data'),
  ('calendar', 'Calendar', 'Create and manage bookings and events.', ARRAY['google_calendar', 'outlook'], 'productivity'),
  ('crm', 'CRM', 'Create/update leads, contacts, and pipeline state.', ARRAY['hubspot', 'salesforce', 'pipedrive'], 'sales'),
  ('image_generation', 'Image Generation', 'Generate images from prompts.', ARRAY['openai_images', 'midjourney', 'stability'], 'creative'),
  ('lead_enrichment', 'Lead Enrichment', 'Augment lead records with additional data.', ARRAY['clearbit', 'apollo', 'hunter'], 'sales'),
  ('chatbot', 'Chatbot', 'Conversational AI interaction and support.', ARRAY['openai', 'grok', 'claude'], 'ai'),
  ('notifications', 'Notifications', 'Publish real-time operational alerts.', ARRAY['telegram', 'slack', 'email'], 'messaging'),
  ('social_posting', 'Social Posting', 'Publish content to social channels.', ARRAY['linkedin', 'x', 'instagram'], 'marketing'),
  ('document_extraction', 'Document Extraction', 'Parse docs, forms, invoices and contracts.', ARRAY['ocr', 'layout_parser', 'openai'], 'documents'),
  ('webhook', 'Webhook', 'Receive and emit event callbacks.', ARRAY['webhook', 'http'], 'integration'),
  ('monitoring', 'Monitoring', 'Observe workflow health and runtime outcomes.', ARRAY['datadog', 'grafana', 'internal_runtime'], 'ops'),
  ('market_data', 'Market Data', 'Query financial and market feeds.', ARRAY['coinmarketcap', 'coingecko', 'binance'], 'finance')
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  provider_examples = EXCLUDED.provider_examples,
  category = EXCLUDED.category,
  updated_at = now();

-- Seed skill packs
INSERT INTO skill_packs (name, description, tools, capabilities, patterns, activation_keywords)
VALUES
  ('ECOMMERCE PACK', 'Automations for commerce, order flow, inventory, and customer updates.', ARRAY['shopify', 'stripe', 'whatsapp', 'email'], ARRAY['payment', 'database_storage', 'notifications', 'crm'], ARRAY['order_alerts', 'cart_recovery', 'stock_monitor'], ARRAY['shopify', 'store', 'order', 'ecommerce']),
  ('MARKETING PACK', 'Lead-gen, campaign delivery, social distribution, and analytics.', ARRAY['reddit', 'email', 'linkedin', 'airtable'], ARRAY['lead_enrichment', 'social_posting', 'email_send', 'search'], ARRAY['lead_generation', 'campaign_orchestration', 'social_scheduler'], ARRAY['marketing', 'campaign', 'lead', 'newsletter']),
  ('AI AGENTS PACK', 'AI assistants, copilots, and autonomous workers.', ARRAY['openai', 'grok', 'anthropic', 'supabase'], ARRAY['chatbot', 'memory', 'vector_search', 'monitoring'], ARRAY['ai_employee', 'support_agent', 'knowledge_bot'], ARRAY['agent', 'assistant', 'copilot', 'autonomous']),
  ('VOICE PACK', 'Voice intake, call automation, and voice support agents.', ARRAY['twilio', 'deepgram', 'elevenlabs'], ARRAY['speech_to_text', 'text_to_speech', 'notifications'], ARRAY['voice_receptionist', 'call_triage'], ARRAY['voice', 'call', 'phone']),
  ('CONTENT CREATOR PACK', 'Content generation, repurposing, and multi-channel publishing.', ARRAY['openai', 'grok', 'youtube', 'notion'], ARRAY['image_generation', 'social_posting', 'chatbot'], ARRAY['content_factory', 'youtube_monitor'], ARRAY['content', 'youtube', 'creator', 'post']),
  ('SEO PACK', 'SEO monitoring, content optimization, and ranking workflows.', ARRAY['search_console', 'ahrefs', 'openai'], ARRAY['search', 'scraping', 'document_extraction'], ARRAY['seo_audit', 'keyword_monitor'], ARRAY['seo', 'keyword', 'ranking']),
  ('REAL ESTATE PACK', 'Lead capture, appointment scheduling, and follow-up automation.', ARRAY['whatsapp', 'calendar', 'crm'], ARRAY['crm', 'calendar', 'notifications', 'chatbot'], ARRAY['real_estate_agent', 'property_followup'], ARRAY['real estate', 'property', 'tenant', 'listing']),
  ('RESTAURANT PACK', 'Order handling, booking, menu support, and customer communication.', ARRAY['whatsapp', 'voice', 'pos'], ARRAY['receive_message', 'send_message', 'database_storage', 'notifications'], ARRAY['restaurant_ai_employee', 'table_booking'], ARRAY['restaurant', 'menu', 'reservation', 'food']),
  ('CRYPTO PACK', 'Crypto market monitoring, alerts, and structured signal delivery.', ARRAY['coinmarketcap', 'telegram', 'grok', 'supabase'], ARRAY['market_data', 'notifications', 'scheduling', 'database_storage'], ARRAY['crypto_alerts', 'price_tracker', 'signal_logger'], ARRAY['crypto', 'coin', 'token', 'market']),
  ('CUSTOMER SUPPORT PACK', 'AI support triage, ticketing, and escalation workflows.', ARRAY['zendesk', 'intercom', 'openai'], ARRAY['chatbot', 'document_extraction', 'notifications'], ARRAY['support_ai', 'ticket_router'], ARRAY['support', 'customer service', 'ticket']),
  ('RECRUITMENT PACK', 'Candidate sourcing, screening, scheduling, and communication.', ARRAY['linkedin', 'email', 'calendar'], ARRAY['search', 'lead_enrichment', 'calendar'], ARRAY['candidate_sourcing', 'interview_orchestration'], ARRAY['recruitment', 'hiring', 'candidate']),
  ('PRODUCTIVITY PACK', 'Internal productivity, reminders, task automation, and reporting.', ARRAY['notion', 'slack', 'email'], ARRAY['scheduling', 'notifications', 'database_storage'], ARRAY['daily_ops_summary', 'task_automation'], ARRAY['productivity', 'ops', 'internal'])
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  tools = EXCLUDED.tools,
  capabilities = EXCLUDED.capabilities,
  patterns = EXCLUDED.patterns,
  activation_keywords = EXCLUDED.activation_keywords,
  updated_at = now();

-- Seed explicit high-value patterns
INSERT INTO automation_patterns (
  name, category, description, intent_keywords, required_tools, optional_tools,
  required_capabilities, workflow_structure, risk, estimated_cost, estimated_complexity,
  schedule_patterns, industry, examples, popularity_score
)
VALUES
  (
    'Crypto Alerts with AI Summaries',
    'monitoring',
    'Track token movement, summarize with AI, alert Telegram, and log every signal.',
    ARRAY['crypto', 'coinmarketcap', 'telegram', 'grok', 'supabase', 'price alert'],
    ARRAY['coinmarketcap', 'telegram', 'supabase'],
    ARRAY['grok', 'openai'],
    ARRAY['market_data', 'scheduling', 'chatbot', 'notifications', 'database_storage'],
    '{"blocks":["schedule_trigger","http_request","ai_summarizer","telegram_send","supabase_insert"]}'::jsonb,
    'medium',
    0.0200,
    'moderate',
    ARRAY['every 15 minutes', 'every 30 minutes', 'hourly'],
    'crypto',
    ARRAY['Telegram crypto signal bot', 'CoinMarketCap momentum monitor'],
    95
  ),
  (
    'E-commerce AI Assistant',
    'commerce',
    'Handle product Q&A, order updates, and follow-up automations for e-commerce stores.',
    ARRAY['shopify', 'whatsapp', 'vision', 'orders', 'assistant'],
    ARRAY['shopify', 'whatsapp'],
    ARRAY['openai', 'supabase'],
    ARRAY['chatbot', 'vision_analysis', 'crm', 'database_storage', 'notifications'],
    '{"blocks":["shopify_trigger","vision_node","ai_agent","whatsapp_send","crm_update"]}'::jsonb,
    'medium',
    0.0300,
    'complex',
    ARRAY['event_driven'],
    'ecommerce',
    ARRAY['WhatsApp shopping assistant', 'Order status concierge'],
    93
  ),
  (
    'Lead Generation with CRM Sync',
    'sales',
    'Collect leads from communities, enrich and sync to CRM with follow-up outreach.',
    ARRAY['lead generation', 'reddit', 'email', 'crm', 'outreach'],
    ARRAY['reddit', 'email', 'crm'],
    ARRAY['apollo', 'clearbit'],
    ARRAY['search', 'lead_enrichment', 'email_send', 'crm'],
    '{"blocks":["search_trigger","lead_enrichment","email_send","crm_upsert"]}'::jsonb,
    'low',
    0.0150,
    'moderate',
    ARRAY['daily', 'weekly'],
    'sales',
    ARRAY['Reddit-to-CRM lead pipeline'],
    89
  ),
  (
    'Restaurant AI Employee',
    'operations',
    'Automate order intake, confirmations, escalations, and backoffice logging.',
    ARRAY['restaurant', 'orders', 'whatsapp', 'voice', 'notifications'],
    ARRAY['whatsapp', 'supabase'],
    ARRAY['voice_provider', 'grok'],
    ARRAY['receive_message', 'send_message', 'speech_to_text', 'database_storage', 'notifications'],
    '{"blocks":["message_trigger","voice_or_text_parser","intent_router","order_db_write","staff_alert"]}'::jsonb,
    'medium',
    0.0180,
    'complex',
    ARRAY['always_on'],
    'restaurant',
    ARRAY['AI front-desk for restaurants'],
    90
  )
ON CONFLICT DO NOTHING;

-- Generate 216 additional pattern seeds (12 categories x 18 variants)
WITH categories AS (
  SELECT * FROM (VALUES
    ('customer_support', 'support', ARRAY['chatbot','document_extraction','notifications']::text[], ARRAY['zendesk','intercom']::text[]),
    ('seo_agent', 'marketing', ARRAY['search','scraping','document_extraction']::text[], ARRAY['search_console','ahrefs']::text[]),
    ('ai_content_factory', 'content', ARRAY['chatbot','social_posting','image_generation']::text[], ARRAY['openai','youtube']::text[]),
    ('youtube_monitor', 'content', ARRAY['search','monitoring','notifications']::text[], ARRAY['youtube','telegram']::text[]),
    ('price_tracker', 'monitoring', ARRAY['market_data','scheduling','notifications']::text[], ARRAY['coinmarketcap','telegram']::text[]),
    ('document_ai', 'operations', ARRAY['document_extraction','database_storage','chatbot']::text[], ARRAY['ocr','supabase']::text[]),
    ('whatsapp_sales_agent', 'sales', ARRAY['send_message','receive_message','crm']::text[], ARRAY['whatsapp','hubspot']::text[]),
    ('social_media_automation', 'marketing', ARRAY['social_posting','scheduling','monitoring']::text[], ARRAY['linkedin','x']::text[]),
    ('crm_followups', 'sales', ARRAY['crm','email_send','scheduling']::text[], ARRAY['hubspot','email']::text[]),
    ('invoice_processor', 'finance', ARRAY['document_extraction','database_storage','notifications']::text[], ARRAY['ocr','supabase']::text[]),
    ('voice_receptionist', 'voice', ARRAY['speech_to_text','text_to_speech','notifications']::text[], ARRAY['twilio','elevenlabs']::text[]),
    ('recruitment_assistant', 'hr', ARRAY['search','lead_enrichment','calendar']::text[], ARRAY['linkedin','calendar']::text[])
  ) AS t(pattern_key, industry, req_caps, req_tools)
),
variants AS (
  SELECT generate_series(1, 18) AS idx
)
INSERT INTO automation_patterns (
  name,
  category,
  description,
  intent_keywords,
  required_tools,
  optional_tools,
  required_capabilities,
  workflow_structure,
  risk,
  estimated_cost,
  estimated_complexity,
  schedule_patterns,
  industry,
  examples,
  popularity_score
)
SELECT
  initcap(replace(c.pattern_key, '_', ' ')) || ' Pattern ' || v.idx,
  c.pattern_key,
  'Generated seed for ' || replace(c.pattern_key, '_', ' ') || ' automation variant ' || v.idx,
  ARRAY[
    replace(c.pattern_key, '_', ' '),
    c.industry,
    'automation',
    CASE WHEN v.idx % 2 = 0 THEN 'agent' ELSE 'workflow' END,
    CASE WHEN v.idx % 3 = 0 THEN 'ai' ELSE 'ops' END
  ],
  c.req_tools,
  ARRAY['supabase','openai','webhook'],
  c.req_caps,
  jsonb_build_object(
    'variant', v.idx,
    'blocks', ARRAY[
      'trigger_block_' || ((v.idx % 4) + 1),
      'ai_block_' || ((v.idx % 5) + 1),
      'action_block_' || ((v.idx % 6) + 1)
    ]
  ),
  CASE WHEN v.idx % 5 = 0 THEN 'high' WHEN v.idx % 2 = 0 THEN 'medium' ELSE 'low' END,
  (0.005 + (v.idx::numeric / 1000.0)),
  CASE WHEN v.idx % 4 = 0 THEN 'complex' WHEN v.idx % 2 = 0 THEN 'moderate' ELSE 'simple' END,
  ARRAY[
    CASE WHEN v.idx % 4 = 0 THEN 'every 15 minutes' ELSE 'daily' END,
    CASE WHEN v.idx % 3 = 0 THEN 'hourly' ELSE 'event_driven' END
  ],
  c.industry,
  ARRAY[
    initcap(replace(c.pattern_key, '_', ' ')) || ' example ' || v.idx,
    'Inspired by internet automation workflows'
  ],
  40 + v.idx
FROM categories c
CROSS JOIN variants v
ON CONFLICT DO NOTHING;