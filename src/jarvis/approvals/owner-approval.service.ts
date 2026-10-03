import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { JarvisApprovalStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ToolRegistry } from '../tools/tool.registry';

export interface CreateOwnerApprovalInput {
  ownerId: string;
  requestedByUserId: string;
  toolId: string;
  intent: string;
  arguments?: unknown;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  expiresAt?: Date;
  recoveryActionId?: string;
}

export interface ConsumeOwnerApprovalInput {
  ownerId: string;
  approvalId: string;
  toolId: string;
  intent: string;
  arguments?: unknown;
  userId: string;
  agent: string;
  permission: string;
}

@Injectable()
export class OwnerApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async create(input: CreateOwnerApprovalInput) {
    this.assertOwnerIdentity(input.ownerId, input.requestedByUserId);

    const tool = this.toolRegistry.get(input.toolId);
    if (!tool) {
      throw new NotFoundException(`JARVIS tool "${input.toolId}" is not registered.`);
    }

    if (tool.scope !== 'owner') {
      throw new BadRequestException(`Tool "${input.toolId}" is not owner-scoped.`);
    }

    if (tool.permission !== 'approval') {
      throw new BadRequestException(`Tool "${input.toolId}" is not approval-gated.`);
    }

    if (input.expiresAt && input.expiresAt <= new Date()) {
      throw new BadRequestException('expiresAt must be in the future.');
    }

    return this.prisma.jarvisOwnerApproval.create({
      data: {
        ownerId: input.ownerId,
        requestedByUserId: input.requestedByUserId,
        toolId: input.toolId,
        intent: input.intent,
        arguments: this.toJson(input.arguments),
        riskLevel: input.riskLevel ?? 'MEDIUM',
        status: JarvisApprovalStatus.PENDING,
        expiresAt: input.expiresAt,
        recoveryActionId: input.recoveryActionId,
      },
    });
  }

  async getPending(ownerId: string) {
    const now = new Date();

    await this.prisma.jarvisOwnerApproval.updateMany({
      where: {
        ownerId,
        status: JarvisApprovalStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: {
        status: JarvisApprovalStatus.EXPIRED,
        decidedAt: now,
      },
    });

    return this.prisma.jarvisOwnerApproval.findMany({
      where: {
        ownerId,
        status: JarvisApprovalStatus.PENDING,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { requestedAt: 'desc' },
    });
  }

  async getById(ownerId: string, approvalId: string) {
    const approval = await this.prisma.jarvisOwnerApproval.findFirst({
      where: { id: approvalId, ownerId },
    });

    if (!approval) {
      throw new NotFoundException(`JARVIS owner approval "${approvalId}" was not found.`);
    }

    return approval;
  }

  async approve(ownerId: string, approvalId: string, decidedByUserId: string) {
    this.assertOwnerIdentity(ownerId, decidedByUserId);
    const approval = await this.getById(ownerId, approvalId);
    this.assertPending(approval);

    const decidedAt = new Date();
    const updated = await this.prisma.jarvisOwnerApproval.updateMany({
      where: {
        id: approval.id,
        ownerId,
        status: JarvisApprovalStatus.PENDING,
        OR: [{ expiresAt: null }, { expiresAt: { gt: decidedAt } }],
      },
      data: {
        status: JarvisApprovalStatus.APPROVED,
        decidedByUserId,
        decidedAt,
      },
    });

    if (updated.count !== 1) {
      throw new BadRequestException('Approval could not be approved because it is no longer pending.');
    }

    if (approval.recoveryActionId) {
      const action = await this.prisma.jarvisOwnerAction.findFirst({ where: { id: approval.recoveryActionId, ownerId } });
      if (action) {
        const recovery = action.recovery && typeof action.recovery === 'object' && !Array.isArray(action.recovery) ? action.recovery as Record<string, unknown> : {};
        await this.prisma.jarvisOwnerAction.update({
          where: { id: action.id },
          data: { recovery: { ...recovery, status: 'RECOVERY_APPROVAL_REQUIRED', recoveryApprovalId: approval.id, recoveryApprovalStatus: JarvisApprovalStatus.APPROVED } as Prisma.InputJsonValue },
        });
      }
    }

    return {
      ...approval,
      status: JarvisApprovalStatus.APPROVED,
      decidedByUserId,
      decidedAt,
    };
  }

  async deny(ownerId: string, approvalId: string, decidedByUserId: string) {
    this.assertOwnerIdentity(ownerId, decidedByUserId);
    const approval = await this.getById(ownerId, approvalId);
    this.assertPending(approval);

    const decidedAt = new Date();
    const updated = await this.prisma.jarvisOwnerApproval.updateMany({
      where: {
        id: approval.id,
        ownerId,
        status: JarvisApprovalStatus.PENDING,
        OR: [{ expiresAt: null }, { expiresAt: { gt: decidedAt } }],
      },
      data: {
        status: JarvisApprovalStatus.DENIED,
        decidedByUserId,
        decidedAt,
      },
    });

    if (updated.count !== 1) {
      throw new BadRequestException('Approval could not be denied because it is no longer pending.');
    }

    return {
      ...approval,
      status: JarvisApprovalStatus.DENIED,
      decidedByUserId,
      decidedAt,
    };
  }

  async consumeForExecution(input: ConsumeOwnerApprovalInput) {
    this.assertOwnerIdentity(input.ownerId, input.userId);
    const requestedArguments = this.toJson(input.arguments);

    return this.prisma.$transaction(async (tx) => {
      const approval = await tx.jarvisOwnerApproval.findFirst({
        where: { id: input.approvalId, ownerId: input.ownerId },
      });

      if (!approval) {
        throw new NotFoundException(`JARVIS owner approval "${input.approvalId}" was not found.`);
      }

      if (approval.status !== JarvisApprovalStatus.APPROVED) {
        throw new BadRequestException(
          `Approval must be APPROVED before execution. Current status: ${approval.status}.`,
        );
      }

      if (approval.executionId) {
        throw new BadRequestException('Approval has already been consumed by an execution.');
      }

      if (approval.expiresAt && approval.expiresAt <= new Date()) {
        throw new BadRequestException('Approval has expired.');
      }

      if (approval.toolId !== input.toolId) {
        throw new BadRequestException(
          `Approval tool mismatch. Approved "${approval.toolId}" but requested "${input.toolId}".`,
        );
      }

      if (approval.intent !== input.intent) {
        throw new BadRequestException(
          `Approval intent mismatch. Approved "${approval.intent}" but requested "${input.intent}".`,
        );
      }

      if (!this.jsonEqual(approval.arguments, requestedArguments)) {
        throw new BadRequestException('Approval arguments do not match the approved arguments.');
      }

      const execution = await tx.jarvisOwnerOperation.create({
        data: {
          ownerId: input.ownerId,
          userId: input.userId,
          agent: input.agent,
          toolId: input.toolId,
          intent: input.intent,
          permission: input.permission,
          approved: true,
          status: 'STARTED',
          actionId: approval.actionId ?? undefined,
          request: this.toJson({
            toolId: input.toolId,
            intent: input.intent,
            arguments: input.arguments,
            approvalId: input.approvalId,
            actionId: approval.actionId ?? undefined,
          }),
        },
      });

      const consumed = await tx.jarvisOwnerApproval.updateMany({
        where: {
          id: approval.id,
          ownerId: input.ownerId,
          status: JarvisApprovalStatus.APPROVED,
          executionId: null,
        },
        data: { executionId: execution.id },
      });

      if (consumed.count !== 1) {
        throw new BadRequestException('Approval could not be consumed because it was already used.');
      }

      return execution;
    });
  }

  private assertOwnerIdentity(ownerId: string, userId: string): void {
    if (!ownerId || !userId || ownerId !== userId) {
      throw new BadRequestException('JARVIS owner approval requires the authenticated owner identity.');
    }
  }

  private assertPending(approval: {
    status: JarvisApprovalStatus;
    expiresAt: Date | null;
  }): void {
    if (approval.status !== JarvisApprovalStatus.PENDING) {
      throw new BadRequestException(`Approval is already ${approval.status}.`);
    }

    if (approval.expiresAt && approval.expiresAt <= new Date()) {
      throw new BadRequestException('Approval has expired.');
    }
  }

  private jsonEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }

  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) return undefined;

    try {
      return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
    } catch {
      throw new BadRequestException('Approval arguments must be JSON serializable.');
    }
  }
}
