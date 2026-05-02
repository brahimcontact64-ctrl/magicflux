/*
  # AI Automation Builder - Core Tables

  ## New Tables

  ### 1. waitlist_signups
  Captures user emails for the pre-launch waitlist.
  - id (uuid, primary key)
  - email (text, unique) - user's email address
  - name (text, optional) - user's name
  - company (text, optional) - user's company name
  - created_at (timestamptz) - signup timestamp

  ### 2. automation_generations
  Tracks every automation generation request for analytics.
  - id (uuid, primary key)
  - prompt (text) - the user's original prompt
  - template_id (text) - which template was matched
  - template_name (text) - human-readable template name
  - industry (text) - property-management | airbnb | shopify
  - session_id (text, optional) - anonymous session tracking
  - created_at (timestamptz) - generation timestamp

  ## Security
  - RLS enabled on both tables
  - Anonymous users can INSERT to waitlist_signups (public signup)
  - Anonymous users can INSERT to automation_generations (anonymous analytics)
  - No SELECT policies on waitlist_signups (admin-only via service role)
  - No SELECT policies on automation_generations (admin-only via service role)

  ## Important Notes
  1. Both tables use anon insert policies for frictionless UX
  2. Admin reads will be handled via service role key in future admin panel
  3. No personal data beyond email is required
*/

-- Create waitlist_signups table
CREATE TABLE IF NOT EXISTS waitlist_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  name text DEFAULT '',
  company text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

-- Create automation_generations table
CREATE TABLE IF NOT EXISTS automation_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt text NOT NULL,
  template_id text NOT NULL,
  template_name text NOT NULL,
  industry text NOT NULL,
  session_id text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE waitlist_signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_generations ENABLE ROW LEVEL SECURITY;

-- Waitlist: allow anonymous inserts (public signup form)
CREATE POLICY "Anyone can join waitlist"
  ON waitlist_signups
  FOR INSERT
  TO anon
  WITH CHECK (email IS NOT NULL AND length(email) > 3);

-- Automation generations: allow anonymous inserts (usage tracking)
CREATE POLICY "Anyone can log automation generation"
  ON automation_generations
  FOR INSERT
  TO anon
  WITH CHECK (prompt IS NOT NULL AND template_id IS NOT NULL);

-- Also allow authenticated users
CREATE POLICY "Authenticated users can join waitlist"
  ON waitlist_signups
  FOR INSERT
  TO authenticated
  WITH CHECK (email IS NOT NULL AND length(email) > 3);

CREATE POLICY "Authenticated users can log automation generation"
  ON automation_generations
  FOR INSERT
  TO authenticated
  WITH CHECK (prompt IS NOT NULL AND template_id IS NOT NULL);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist_signups(email);
CREATE INDEX IF NOT EXISTS idx_automation_gen_template ON automation_generations(template_id);
CREATE INDEX IF NOT EXISTS idx_automation_gen_industry ON automation_generations(industry);
CREATE INDEX IF NOT EXISTS idx_automation_gen_created ON automation_generations(created_at DESC);
