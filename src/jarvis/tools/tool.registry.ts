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
      id: 'jarvis.owner.vercel.deployment-status',
      name: 'Vercel Deployment Status',
      description: 'Read bounded status metadata for the latest owner Vercel deployment.',
      permission: 'owner-observe',
      readOnly: true,
      scope: 'owner',
    },
    {
      id: 'jarvis.owner.vercel.deploy',
      name: 'Vercel Production Deployment',
      description: 'Deploy the selected owner Vercel project from an explicitly approved source.',
      permission: 'approval',
      readOnly: false,
      scope: 'owner',
    },
    {
      id: 'jarvis.owner.github.update-file',
      name: 'GitHub File Update',
      description: 'Replace an explicitly selected owner repository file with approved contents.',
      permission: 'approval',
      readOnly: false,
      scope: 'owner',
    },
    {
      id: 'jarvis.owner.github.create-branch',
      name: 'GitHub Branch Creation',
      description: 'Create an owner repository branch from an explicitly approved base reference.',
      permission: 'approval',
      readOnly: false,
      scope: 'owner',
    },
    {
      id: 'jarvis.owner.github.delete-branch',
      name: 'GitHub Branch Deletion',
      description: 'Delete an explicitly selected non-default owner repository branch after owner approval.',
      permission: 'approval',
      readOnly: false,
      scope: 'owner',
    },
    {
      id: 'jarvis.owner.github.merge-pull-request',
      name: 'GitHub Pull Request Merge',
      description: 'Merge an explicitly selected owner pull request after owner approval.',
      permission: 'approval',
      readOnly: false,
      scope: 'owner',
    },
    {
      id: 'jarvis.owner.github.rerun-workflow',
      name: 'GitHub Workflow Retry',
      description: 'Retry an explicitly selected failed GitHub Actions workflow job after owner approval.',
      permission: 'approval',
      readOnly: false,
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
