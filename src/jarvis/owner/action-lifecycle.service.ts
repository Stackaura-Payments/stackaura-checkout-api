import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { JarvisActionStatus, JarvisApprovalStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OwnerApprovalService } from '../approvals/owner-approval.service';
import { ToolRegistry } from '../tools/tool.registry';
import { OwnerToolExecutor } from './owner-tool.executor';
import { OwnerOperationService } from './owner-operation.service';
import { VercelOwnerService } from './vercel-owner.service';

const DEFAULT_EXPIRY_MS = 15 * 60 * 1000;

type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

@Injectable()
export class ActionLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerApprovalService: OwnerApprovalService,
    private readonly ownerToolExecutor: OwnerToolExecutor,
    private readonly ownerOperationService: OwnerOperationService,
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

  async resume(ownerId: string, actionId: string, userId: string) {
    const action = await this.get(ownerId, actionId);
    this.assertOwner(ownerId, userId);
    if (action.status !== JarvisActionStatus.RECOVERY_REQUIRED) {
      throw new BadRequestException('JARVIS action must be RECOVERY_REQUIRED before resume.');
    }
    if (!action.approval) throw new BadRequestException('Action has no approval record.');
    // Payment recovery is a new governed mutation attempt. Never reuse the
    // original approval for a provider rejection or failed verification.
    if (action.toolId === 'jarvis.owner.payments.failover') {
      return this.ensureRecoveryApproval(ownerId, userId, action);
    }
    if (action.approval.expiresAt && action.approval.expiresAt <= new Date()) {
      return this.ensureRecoveryApproval(ownerId, userId, action);
    }
    if (action.approval.status !== JarvisApprovalStatus.APPROVED) {
      throw new BadRequestException('The original owner approval is no longer APPROVED.');
    }
    if (!this.jsonEqual(action.arguments, action.approval.arguments)) {
      throw new BadRequestException('The action no longer matches its original approved arguments.');
    }

    const claim = await this.prisma.jarvisOwnerAction.updateMany({
      where: { id: action.id, ownerId, status: JarvisActionStatus.RECOVERY_REQUIRED },
      data: { status: JarvisActionStatus.EXECUTING, startedAt: new Date(), completedAt: null },
    });
    if (claim.count !== 1) {
      throw new ConflictException('JARVIS recovery action is no longer available for resume.');
    }

    const operation = await this.ownerOperationService.start({
      ownerId,
      userId,
      agent: 'chief-of-staff',
      toolId: action.toolId,
      intent: action.intent,
      permission: 'approval',
      approved: true,
      request: {
        toolId: action.toolId,
        intent: action.intent,
        arguments: action.arguments,
        approvalId: action.approval.id,
        actionId: action.id,
        recovery: true,
      },
    });

    try {
      const result = await this.ownerToolExecutor.executeApprovedRecovery(action.toolId, {
        identity: { ownerId, userId },
        agent: 'chief-of-staff',
        intent: action.intent,
        arguments: action.arguments,
        approvalId: action.approval.id,
      });
      const sanitizedResult = result;
      await this.ownerOperationService.succeed(operation.id, sanitizedResult);
      await this.prisma.jarvisOwnerAction.update({
        where: { id: action.id },
        data: { status: JarvisActionStatus.VERIFYING, executionId: operation.id },
      });
      return this.verify(ownerId, action.id, result);
    } catch (error) {
      await this.ownerOperationService.fail(operation.id, error);
      await this.prisma.jarvisOwnerAction.update({
        where: { id: action.id },
        data: {
          status: JarvisActionStatus.RECOVERY_REQUIRED,
          executionId: operation.id,
          recovery: this.toJson({
            reason: this.safeError(error),
            available: true,
            plan: (action.toolId.startsWith('jarvis.owner.github.') || action.toolId === 'jarvis.owner.payments.failover')
              ? this.ownerToolExecutor.getRecoveryPlan(action.toolId, action.arguments)
              : undefined,
          }),
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  private async ensureRecoveryApproval(ownerId: string, userId: string, action: Prisma.JarvisOwnerActionGetPayload<{ include: { approval: true } }>) {
    const recovery = this.objectFromJson(action.recovery);
    const existingApprovalId = typeof recovery.recoveryApprovalId === 'string' ? recovery.recoveryApprovalId : undefined;

    if (existingApprovalId) {
      const existing = await this.ownerApprovalService.getById(ownerId, existingApprovalId);
      if (existing.status === JarvisApprovalStatus.PENDING && (!existing.expiresAt || existing.expiresAt > new Date())) {
        return { ...action, recovery: { ...recovery, status: 'RECOVERY_APPROVAL_REQUIRED', recoveryApprovalStatus: existing.status }, recoveryApproval: existing, requiresApproval: true };
      }
      if (existing.status === JarvisApprovalStatus.APPROVED) {
        if (!this.jsonEqual(existing.arguments, action.arguments)) throw new BadRequestException('The recovery approval arguments do not match the original approved action.');
        return this.executeRecoveryWithApproval(ownerId, userId, action, existing);
      }
    }

    const approval = await this.ownerApprovalService.create({
      ownerId,
      requestedByUserId: userId,
      toolId: action.toolId,
      intent: `RECOVERY RESUME — ${action.intent}`,
      arguments: action.arguments,
      riskLevel: action.riskLevel,
      expiresAt: new Date(Date.now() + DEFAULT_EXPIRY_MS),
      recoveryActionId: action.id,
    });
    const updated = await this.prisma.jarvisOwnerAction.update({
      where: { id: action.id },
      data: { recovery: this.toJson({ ...recovery, status: 'RECOVERY_APPROVAL_REQUIRED', available: true, recoveryApprovalId: approval.id, recoveryApprovalStatus: approval.status, originalApprovalId: action.approval?.id, originalApprovalStatus: action.approval?.status, originalApprovalExpiredAt: action.approval?.expiresAt }) },
      include: { approval: true },
    });
    return { ...updated, recoveryApproval: approval, requiresApproval: true };
  }

  private async executeRecoveryWithApproval(ownerId: string, userId: string, action: Prisma.JarvisOwnerActionGetPayload<{ include: { approval: true } }>, recoveryApproval: Prisma.JarvisOwnerApprovalGetPayload<{}>) {
    const claim = await this.prisma.jarvisOwnerAction.updateMany({
      where: { id: action.id, ownerId, status: JarvisActionStatus.RECOVERY_REQUIRED },
      data: { status: JarvisActionStatus.EXECUTING, startedAt: new Date(), completedAt: null },
    });
    if (claim.count !== 1) throw new ConflictException('JARVIS recovery action is no longer available for resume.');

    const operation = await this.ownerOperationService.start({
      ownerId, userId, agent: 'chief-of-staff', toolId: action.toolId, intent: action.intent, permission: 'approval', approved: true,
      request: { toolId: action.toolId, intent: action.intent, arguments: action.arguments, approvalId: recoveryApproval.id, originalApprovalId: action.approval?.id, actionId: action.id, recovery: true },
    });
    try {
      const result = await this.ownerToolExecutor.executeApprovedRecovery(action.toolId, { identity: { ownerId, userId }, agent: 'chief-of-staff', intent: action.intent, arguments: action.arguments, approvalId: recoveryApproval.id });
      await this.ownerOperationService.succeed(operation.id, result);
      await this.prisma.jarvisOwnerAction.update({ where: { id: action.id }, data: { status: JarvisActionStatus.VERIFYING, executionId: operation.id } });
      return this.verify(ownerId, action.id, result);
    } catch (error) {
      await this.ownerOperationService.fail(operation.id, error);
      await this.prisma.jarvisOwnerAction.update({ where: { id: action.id }, data: { status: JarvisActionStatus.RECOVERY_REQUIRED, executionId: operation.id, recovery: this.toJson({ reason: this.safeError(error), available: true, recoveryApprovalId: recoveryApproval.id, recoveryApprovalStatus: recoveryApproval.status, originalApprovalId: action.approval?.id }), completedAt: new Date() } });
      throw error;
    }
  }

  async execute(ownerId: string, actionId: string, userId: string) {
    const action = await this.get(ownerId, actionId);
    this.assertOwner(ownerId, userId);
    if (action.status !== JarvisActionStatus.APPROVED) {
      throw new BadRequestException('JARVIS action must be APPROVED before execution.');
    }
    if (!action.approval) throw new BadRequestException('Action has no approval record.');

    const claim = await this.prisma.jarvisOwnerAction.updateMany({
      where: {
        id: action.id,
        ownerId,
        status: JarvisActionStatus.APPROVED,
      },
      data: {
        status: JarvisActionStatus.EXECUTING,
        startedAt: new Date(),
      },
    });
    if (claim.count !== 1) {
      throw new ConflictException('JARVIS action is no longer available for execution.');
    }

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
          recovery: this.toJson({
            reason: this.safeError(error),
            available: true,
            plan: (action.toolId.startsWith('jarvis.owner.github.') || action.toolId === 'jarvis.owner.payments.failover')
              ? this.ownerToolExecutor.getRecoveryPlan(action.toolId, action.arguments)
              : undefined,
          }),
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
    } else if ((action.toolId.startsWith('jarvis.owner.github.') || action.toolId === 'jarvis.owner.payments.failover')) {
      verification = await this.ownerToolExecutor.verify(action.toolId, action.arguments, result);
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
        recovery: verified
          ? undefined
          : this.toJson({
              reason: 'Verification failed.',
              available: true,
              plan: (action.toolId.startsWith('jarvis.owner.github.') || action.toolId === 'jarvis.owner.payments.failover')
                ? this.ownerToolExecutor.getRecoveryPlan(action.toolId, action.arguments)
                : undefined,
            }),
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

  private jsonEqual(left: unknown, right: unknown): boolean {
    try { return JSON.stringify(left) === JSON.stringify(right); }
    catch { return false; }
  }

  private objectFromJson(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
