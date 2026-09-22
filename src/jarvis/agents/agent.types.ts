export type AgentId =
  | 'chief-of-staff'
  | 'engineering'
  | 'payments'
  | 'finance'
  | 'marketing'
  | 'support'
  | 'research'
  | 'github'
  | 'vercel'
  | 'supabase'
  | 'shopify-owner';

export type JarvisAgentScope = 'owner' | 'merchant';

export interface JarvisAgent {
  id: AgentId;
  scope: JarvisAgentScope;
  name: string;
  description: string;
  capabilities: string[];
  enabled: boolean;
}
