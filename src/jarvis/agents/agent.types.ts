export type AgentId =
  | 'chief-of-staff'
  | 'engineering'
  | 'payments'
  | 'finance'
  | 'marketing'
  | 'support'
  | 'research';

export interface JarvisAgent {
  id: AgentId;
  name: string;
  description: string;
  capabilities: string[];
  enabled: boolean;
}
