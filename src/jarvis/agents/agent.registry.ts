import { Injectable } from '@nestjs/common';
import { AgentId, JarvisAgent } from './agent.types';

@Injectable()
export class AgentRegistry {
  private readonly agents: JarvisAgent[] = [
    {
      id: 'chief-of-staff',
      scope: 'owner',
      name: 'JARVIS Chief of Staff',
      description: 'Coordinates the Stackaura AI workforce and manages execution.',
      capabilities: [
        'orchestration',
        'planning',
        'delegation',
        'status',
        'approvals',
      ],
      enabled: true,
    },
    {
      id: 'engineering',
      scope: 'owner',
      name: 'Engineering Agent',
      description: 'Investigates software, infrastructure, deployments and technical incidents.',
      capabilities: [
        'github',
        'debugging',
        'testing',
        'deployment',
        'infrastructure',
      ],
      enabled: true,
    },
    {
      id: 'payments',
      scope: 'merchant',
      name: 'Payments Agent',
      description: 'Monitors payment gateways, transactions, webhooks and payment operations.',
      capabilities: [
        'payments',
        'gateway-health',
        'transactions',
        'webhooks',
        'reconciliation',
      ],
      enabled: true,
    },
    {
      id: 'finance',
      scope: 'merchant',
      name: 'Finance Agent',
      description: 'Analyzes financial performance, revenue and business metrics.',
      capabilities: [
        'revenue',
        'financial-analysis',
        'kpis',
        'reporting',
      ],
      enabled: true,
    },
    {
      id: 'marketing',
      scope: 'owner',
      name: 'Marketing Agent',
      description: 'Handles marketing intelligence, content and customer acquisition workflows.',
      capabilities: [
        'marketing',
        'content',
        'campaigns',
        'analytics',
      ],
      enabled: true,
    },
    {
      id: 'support',
      scope: 'merchant',
      name: 'Support Agent',
      description: 'Handles customer support intelligence and escalation workflows.',
      capabilities: [
        'customer-support',
        'support-analysis',
        'escalation',
      ],
      enabled: true,
    },
    {
      id: 'research',
      scope: 'owner',
      name: 'Research Agent',
      description: 'Researches markets, competitors, technology and relevant external information.',
      capabilities: [
        'research',
        'competitor-analysis',
        'market-intelligence',
      ],
      enabled: true,
    },
    {
      id: 'github',
      scope: 'owner',
      name: 'GitHub Agent',
      description: 'Inspects Stackaura source repositories and GitHub engineering state.',
      capabilities: ['repositories', 'branches', 'pull-requests', 'issues', 'read-only-code-intelligence'],
      enabled: true,
    },
    {
      id: 'vercel',
      scope: 'owner',
      name: 'Vercel Agent',
      description: 'Inspects Stackaura frontend and deployment state on Vercel.',
      capabilities: ['projects', 'deployments', 'domains', 'build-status', 'read-only-deployment-intelligence'],
      enabled: true,
    },
    {
      id: 'supabase',
      scope: 'owner',
      name: 'Supabase Agent',
      description: 'Inspects approved Stackaura data-platform state through bounded owner capabilities.',
      capabilities: ['projects', 'database-health', 'migrations', 'edge-functions', 'read-only-data-platform-intelligence'],
      enabled: true,
    },
    {
      id: 'shopify-owner',
      scope: 'owner',
      name: 'Shopify Owner Agent',
      description: 'Inspects the Stackaura-owned Shopify integration through dedicated owner-scoped capabilities.',
      capabilities: ['store-status', 'app-installation', 'webhooks', 'support-agent-status', 'read-only-store-intelligence'],
      enabled: true,
    },
  ];

  list(): JarvisAgent[] {
    return this.agents;
  }

  get(agentId: AgentId): JarvisAgent | undefined {
    return this.agents.find((agent) => agent.id === agentId);
  }
}
