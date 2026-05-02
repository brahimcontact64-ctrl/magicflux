import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type WaitlistSignup = {
  id?: string;
  email: string;
  name?: string;
  company?: string;
  created_at?: string;
};

export type AutomationGeneration = {
  id?: string;
  prompt: string;
  template_id: string;
  template_name: string;
  industry: string;
  session_id?: string;
  created_at?: string;
};

export type WorkflowDeployment = {
  id?: string;
  user_id?: string;
  session_id?: string;
  template_id: string;
  template_name: string;
  industry: string;
  deployment_mode: 'download' | 'self_deploy' | 'managed';
  status: 'pending' | 'deploying' | 'active' | 'failed' | 'cancelled';
  n8n_workflow_id?: string;
  n8n_instance_url?: string;
  error_message?: string;
  workflow_json?: object;
  applied_customizations?: string[];
  package_score?: object;
  created_at?: string;
};

export type ManagedRequest = {
  id?: string;
  user_id?: string;
  deployment_id?: string;
  request_type: 'setup' | 'customization' | 'support';
  template_id?: string;
  template_name?: string;
  description: string;
  contact_email: string;
  status: 'open' | 'in_progress' | 'resolved' | 'cancelled';
  created_at?: string;
};