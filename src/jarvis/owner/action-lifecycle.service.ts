import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { JarvisActionStatus, JarvisApprovalStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OwnerApprovalService } from '../approvals/owner-approval.service';
import { ToolRegistry } from '../tools/tool.registry';
import { OwnerToolExecutor } from './owner-tool.executor';
import { VercelOwnerService } from './vercel-owner.service';

const DEFAULT_EXPIRY_MS = 15 * 60 * 1000;

type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

@Injectable()
export class ActionLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerApprovalService: OwnerApprovalService,
    private readonly ownerToolExecutor: OwnerToolExecutor,
    private readonly toolRegistry: ToolRegistry,
    private readonly vercelOwnerService: VercelOwnerService,
  ) {}

  async propose(input: {
    ownerId: string;
    requestedByUserId: string;
    toolId: string;
    intent: string;
    arguments?: unknown;
    riskLevel?: RiskLevel;
    expiresAt?: Date;
  }) {
    this.assertOwner(input.ownerId, input.requestedByUserId);
    const tool = this.toolRegistry.get(input.toolId);
    if (!tool) throw new NotFoundException('JARVIS tool is not registered.');
    if (tool.scope !== 'owner' || tool.permission !== 'approval') {
      throw new BadRequestException('JARVIS action lifecycle requires an owner approval-gated tool.');
    }
    const expiresAt = input.expiresAt ?? new Date(Date.now() + DEFAULT_EXPIRY_MS);
    if (expiresAt <= new Date()) throw new BadRequestException('expiresAt must be in the future.');
    const args = this.toJson(input.arguments);

    return this.prisma.$transaction(async (tx) => {
      const action = await tx.jarvisOwnerAction.create({
        data: {
          ownerId: input.ownerId,
          requestedBy: input.requestedByUserId,
          toolId: input.toolId,
          intent: input.intent,
          arguments: args,
          riskLevel: input.riskLevel ?? 'MEDIUM',
          status: JarvisActionStatus.PENDING_APPROVAL,
        },
      });
      const approval = await tx.jarvisOwnerApproval.create({
        data: {
          ownerId: input.ownerId,
          requestedByUserId: input.requestedByUserId,
          toolId: input.toolId,
          intent: input.intent,
          arguments: args,
          riskLevel: input.riskLevel ?? 'MEDIUM',
          status: JarvisApprovalStatus.PENDING,
          expiresAt,
          actionId: action.id,
        },
      });
      return { action, approval };
    });
  }

  async list(ownerId: string, status?: JarvisActionStatus, limit = 25) {
    await this.expirePending(ownerId);
    return this.prisma.jarvisOwnerAction.findMany({
      where: { ownerId, ...(status ? { status } : {}) },
      include: { approval: true },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async get(ownerId: string, actionId: string) {
    const action = await this.prisma.jarvisOwnerAction.findFirst({
      where: { id: actionId, ownerId },
      include: { approval: true },
    });
    if (!action) throw new NotFoundException('JARVIS action was not found.');
    return action;
  }

  async approve(ownerId: string, actionId: string, userId: string) {
    const action = await this.get(ownerId, actionId);
    if (!action.approval) throw new BadRequestException('Action has no approval record.');
    await this.ownerApprovalService.approve(ownerId, action.approval.id, userId);
    return this.prisma.jarvisOwnerAction.update({
      where: { id: action.id },
      data: { status: JarvisActionStatus.APPROVED, approvedAt: new Date() },
      include: { approval: true },
    });
  }

  async deny(ownerId: string, actionId: string, userId: string) {
    const action = await this.get(ownerId, actionId);
    if (!action.approval) throw new BadRequestException('Action has no approval record.');
    await this.ownerApprovalService.deny(ownerId, action.approval.id, userId);
    return this.prisma.jarvisOwnerAction.update({
      where: { id: action.id },
      data: { status: JarvisActionStatus.DENIED, completedAt: new Date() },
      include: { approval: true },
    });
  }

  async execute(ownerId: string, actionId: string, userId: string) {
    const action = await this.get(ownerId, actionId);
    this.assertOwner(ownerId, userId);
    if (action.status !== JarvisActionStatus.APPROVED) {
      throw new BadRequestException('JARVIS action must be APPROVED before execution.');
    }
    if (!action.approval) throw new BadRequestException('Action has no approval record.');

    await this.prisma.jarvisOwnerAction.update({
      where: { id: action.id },
      data: { status: JarvisActionStatus.EXECUTING, startedAt: new Date() },
    });

    try {
      const result = await this.ownerToolExecutor.execute(action.toolId, {
        identity: { ownerId, userId },
        agent: 'chief-of-staff',
        intent: action.intent,
        arguments: action.arguments,
        approvalId: action.approval.id,
      });
      const operation = await this.prisma.jarvisOwnerOperation.findFirst({
        where: { actionId: action.id, ownerId },
        orderBy: { createdAt: 'desc' },
      });
      await this.prisma.jarvisOwnerAction.update({
        where: { id: action.id },
        data: {
          status: JarvisActionStatus.VERIFYING,
          executionId: operation?.id,
        },
      });
      return this.verify(ownerId, action.id, result);
    } catch (error) {
      await this.prisma.jarvisOwnerAction.update({
        where: { id: action.id },
        data: {
          status: JarvisActionStatus.RECOVERY_REQUIRED,
          recovery: this.toJson({ reason: this.safeError(error), available: true }),
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  async verify(ownerId: string, actionId: string, result?: unknown) {
    const action = await this.get(ownerId, actionId);
    if (action.status !== JarvisActionStatus.VERIFYING) {
      throw new BadRequestException('JARVIS action must be VERIFYING before verification.');
    }

    let verification: Record<string, unknown>;
    if (action.toolId === 'jarvis.owner.vercel.deploy') {
      const deploymentId = this.stringFromResult(result, 'id', 'uid');
      verification = await this.vercelOwnerService.verifyDeployment(deploymentId);
    } else {
      verification = { verified: true, mode: 'provider-acknowledged', checkedAt: new Date().toISOString() };
    }

    const verified = verification.verified === true;
    return this.prisma.jarvisOwnerAction.update({
      where: { id: action.id },
      data: {
        status: verified ? JarvisActionStatus.SUCCEEDED : JarvisActionStatus.RECOVERY_REQUIRED,
        verification: this.toJson(verification),
        completedAt: verified ? new Date() : undefined,
        recovery: verified ? undefined : this.toJson({ reason: 'Verification failed.', available: true }),
      },
      include: { approval: true },
    });
  }

  async proposeRecovery(input: {
    ownerId: string;
    requestedByUserId: string;
    actionId: string;
    toolId: string;
    intent: string;
    arguments?: unknown;
    riskLevel?: RiskLevel;
  }) {
    const original = await this.get(input.ownerId, input.actionId);
    if (original.status !== JarvisActionStatus.FAILED && original.status !== JarvisActionStatus.RECOVERY_REQUIRED) {
      throw new BadRequestException('Recovery can only be proposed for a failed or verification-failed action.');
    }
    const proposal = await this.propose(input);
    await this.prisma.jarvisOwnerAction.update({
      where: { id: original.id },
      data: { recovery: this.toJson({ recoveryActionId: proposal.action.id, status: 'PROPOSED' }) },
    });
    return proposal;
  }

  private async expirePending(ownerId: string) {
    const now = new Date();
    const expired = await this.prisma.jarvisOwnerAction.findMany({
      where: { ownerId, status: JarvisActionStatus.PENDING_APPROVAL, approval: { expiresAt: { lte: now } } },
      select: { id: true },
    });
    if (expired.length) {
      await this.prisma.jarvisOwnerAction.updateMany({
        where: { id: { in: expired.map((item) => item.id) } },
        data: { status: JarvisActionStatus.EXPIRED, completedAt: now },
      });
    }
  }

  private assertOwner(ownerId: string, userId: string) {
    if (!ownerId || !userId || ownerId !== userId) {
      throw new BadRequestException('JARVIS owner identity is required.');
    }
  }

  private stringFromResult(value: unknown, ...keys: string[]): string {
    if (!value || typeof value !== 'object') throw new BadRequestException('Mutation returned no verifiable provider result.');
    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    throw new BadRequestException('Mutation returned no verifiable deployment identifier.');
  }

  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
    catch { throw new BadRequestException('JARVIS action data must be JSON serializable.'); }
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
