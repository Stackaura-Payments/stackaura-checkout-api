import { Injectable } from '@nestjs/common';
import { AgentId, JarvisAgent } from './agent.types';

@Injectable()
export class AgentRegistry {
  private readonly agents: JarvisAgent[] = [
    {
      id: 'chief-of-staff',
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
      name: 'Research Agent',
      description: 'Researches markets, competitors, technology and relevant external information.',
      capabilities: [
        'research',
        'competitor-analysis',
        'market-intelligence',
      ],
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
