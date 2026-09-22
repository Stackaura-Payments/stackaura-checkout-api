import { Injectable } from '@nestjs/common';
import { JarvisTool } from './tool.types';

@Injectable()
export class ToolRegistry {
  private readonly tools: JarvisTool[] = [
    {
      id: 'jarvis.owner-operations.list',
      name: 'Owner Operation History',
      description: 'Read the authenticated owner’s JARVIS operation history.',
      permission: 'owner-observe',
      readOnly: true,
      scope: 'owner',
    },
    {
      id: 'jarvis.owner.github.repository-status',
      name: 'GitHub Repository Status',
      description:
        'Read bounded status metadata for an explicitly selected owner repository.',
      permission: 'owner-observe',
      readOnly: true,
      scope: 'owner',
    },
    {
      id: 'jarvis.approval-test',
      name: 'JARVIS Approval Test',
      description:
        'Harmless approval-gated tool used to verify the JARVIS authorization workflow.',
      permission: 'approval',
      readOnly: true,
      scope: 'merchant',
    },
    {
      id: 'command-center.overview',
      name: 'Command Center Overview',
      description: 'Read the current Stackaura operational overview.',
      permission: 'observe',
      readOnly: true,
      scope: 'merchant',
    },
    {
      id: 'payments.recent',
      name: 'Recent Payments',
      description: 'Read the most recent Stackaura payments.',
      permission: 'observe',
      readOnly: true,
      scope: 'merchant',
    },
    {
      id: 'payments.gateway-health',
      name: 'Gateway Health',
      description: 'Read payment gateway activity and health metrics.',
      permission: 'observe',
      readOnly: true,
      scope: 'merchant',
    },
    {
      id: 'payments.webhook-health',
      name: 'Webhook Health',
      description: 'Read webhook delivery health and success metrics.',
      permission: 'observe',
      readOnly: true,
      scope: 'merchant',
    },
    {
      id: 'finance.revenue-summary',
      name: 'Revenue Summary',
      description: 'Read the current Stackaura revenue and payment summary.',
      permission: 'observe',
      readOnly: true,
      scope: 'merchant',
    },
  ];

  get(toolId: string): JarvisTool | undefined {
    return this.tools.find((tool) => tool.id === toolId);
  }

  list(): JarvisTool[] {
    return [...this.tools];
  }
}
