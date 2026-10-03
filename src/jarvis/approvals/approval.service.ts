import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  JarvisApprovalStatus,
  MembershipRole,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ToolRegistry } from '../tools/tool.registry';
import { AuditService } from '../audit/audit.service';

export interface CreateApprovalInput {
  merchantId: string;
  userId?: string;
  toolId: string;
  intent: string;
  arguments?: unknown;
  expiresAt?: Date;
}

export interface ConsumeApprovalInput {
  merchantId: string;
  approvalId: string;
  toolId: string;
  intent: string;
  arguments?: unknown;
  userId?: string;
  agent: string;
  permission: string;
}

@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async create(input: CreateApprovalInput) {
  const tool = this.toolRegistry.get(input.toolId);

  if (!tool) {
    throw new NotFoundException(
      `JARVIS tool "${input.toolId}" is not registered.`,
    );
  }

  if (tool.permission !== 'approval') {
    throw new BadRequestException(
      `Tool "${input.toolId}" does not require approval.`,
    );
  }

  if (
    input.expiresAt &&
    input.expiresAt <= new Date()
  ) {
    throw new BadRequestException(
      'expiresAt must be in the future.',
    );
  }

  return this.prisma.jarvisApproval.create({
    data: {
      merchantId: input.merchantId,
      userId: input.userId,
      toolId: input.toolId,
      intent: input.intent,
      arguments: this.toJson(input.arguments),
      status: JarvisApprovalStatus.PENDING,
      expiresAt: input.expiresAt,
    },
  });
}

  private async assertCanDecide(
  merchantId: string,
  userId: string,
): Promise<void> {
  const membership =
    await this.prisma.membership.findFirst({
      where: {
        merchantId,
        userId,
      },
      select: {
        role: true,
      },
    });

  if (!membership) {
    throw new BadRequestException(
      'User is not a member of this merchant.',
    );
  }

  if (
    membership.role !== MembershipRole.OWNER &&
    membership.role !== MembershipRole.ADMIN
  ) {
    throw new BadRequestException(
      'Only merchant owners and admins can approve or deny JARVIS actions.',
    );
  }
}

  async getPending(merchantId: string) {
  const now = new Date();

  await this.prisma.jarvisApproval.updateMany({
    where: {
      merchantId,
      status: JarvisApprovalStatus.PENDING,
      expiresAt: {
        lte: now,
      },
    },
    data: {
      status: JarvisApprovalStatus.EXPIRED,
      decidedAt: now,
    },
  });

  return this.prisma.jarvisApproval.findMany({
    where: {
      merchantId,
      status: JarvisApprovalStatus.PENDING,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    orderBy: {
      requestedAt: 'desc',
    },
  });
}

  async getById(
    merchantId: string,
    approvalId: string,
  ) {
    const approval =
      await this.prisma.jarvisApproval.findFirst({
        where: {
          id: approvalId,
          merchantId,
        },
      });

    if (!approval) {
      throw new NotFoundException(
        `JARVIS approval "${approvalId}" was not found.`,
      );
    }

    return approval;
  }

  async deny(
    merchantId: string,
    approvalId: string,
    decidedByUserId: string,
  ) {
    const approval = await this.getById(
      merchantId,
      approvalId,
    );

    await this.assertCanDecide(
      merchantId,
      decidedByUserId,
    );

    await this.assertPending(approval);

    const decidedAt = new Date();

    const updated =
      await this.prisma.jarvisApproval.updateMany({
        where: {
          id: approval.id,
          merchantId,
          status: JarvisApprovalStatus.PENDING,
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: decidedAt } },
          ],
        },
        data: {
          status: JarvisApprovalStatus.DENIED,
          decidedByUserId,
          decidedAt,
        },
      });

    if (updated.count !== 1) {
      throw new BadRequestException(
        'Approval could not be denied because it is no longer pending.',
      );
    }

    return {
      ...approval,
      status: JarvisApprovalStatus.DENIED,
      decidedByUserId,
      decidedAt,
    };
  }

  async approve(
    merchantId: string,
    approvalId: string,
    decidedByUserId: string,
  ) {
    const approval = await this.getById(
      merchantId,
      approvalId,
    );

    await this.assertCanDecide(
      merchantId,
      decidedByUserId,
    );

    await this.assertPending(approval);

    const decidedAt = new Date();

    const updated =
      await this.prisma.jarvisApproval.updateMany({
        where: {
          id: approval.id,
          merchantId,
          status: JarvisApprovalStatus.PENDING,
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: decidedAt } },
          ],
        },
        data: {
          status: JarvisApprovalStatus.APPROVED,
          decidedByUserId,
          decidedAt,
        },
      });

    if (updated.count !== 1) {
      throw new BadRequestException(
        'Approval could not be approved because it is no longer pending.',
      );
    }

    return {
      ...approval,
      status: JarvisApprovalStatus.APPROVED,
      decidedByUserId,
      decidedAt,
    };
  }

  /**
   * Atomically consumes an APPROVED approval and creates the
   * corresponding JarvisExecution audit record.
   *
   * The approval is one-shot:
   *
   *   APPROVED + executionId NULL -> consumable
   *   APPROVED + executionId set  -> replay rejected
   *
   * The exact tool, intent and arguments are checked before the
   * approval can be consumed.
   */
  async consumeForExecution(
    input: ConsumeApprovalInput,
  ) {
    const requestedArguments = this.toJson(input.arguments);

    return this.prisma.$transaction(async (tx) => {
      const approval =
        await tx.jarvisApproval.findFirst({
          where: {
            id: input.approvalId,
            merchantId: input.merchantId,
          },
        });

      if (!approval) {
        throw new NotFoundException(
          `JARVIS approval "${input.approvalId}" was not found.`,
        );
      }

      if (
        approval.status !==
        JarvisApprovalStatus.APPROVED
      ) {
        throw new BadRequestException(
          `Approval must be APPROVED before execution. Current status: ${approval.status}.`,
        );
      }

      if (approval.executionId) {
        throw new BadRequestException(
          'Approval has already been consumed by an execution.',
        );
      }

      if (
        approval.expiresAt &&
        approval.expiresAt <= new Date()
      ) {
        throw new BadRequestException(
          'Approval has expired.',
        );
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

      if (
        !this.jsonEqual(
          approval.arguments,
          requestedArguments,
        )
      ) {
        throw new BadRequestException(
          'Approval arguments do not match the approved arguments.',
        );
      }

      const execution =
        await tx.jarvisExecution.create({
          data: {
            merchantId: input.merchantId,
            userId: input.userId,
            agent: input.agent,
            toolId: input.toolId,
            intent: input.intent,
            permission: input.permission,
            approved: true,
            status: 'STARTED',
            request: this.toJson({
              toolId: input.toolId,
              intent: input.intent,
              arguments: input.arguments,
              approvalId: input.approvalId,
            }),
          },
        });

      /*
       * This update is the one-shot consumption boundary.
       *
       * executionId is unique, and the WHERE clause requires the
       * approval to still be unconsumed. A concurrent replay cannot
       * consume the same approval.
       */
      const consumed =
        await tx.jarvisApproval.updateMany({
          where: {
            id: approval.id,
            merchantId: input.merchantId,
            status: JarvisApprovalStatus.APPROVED,
            executionId: null,
          },
          data: {
            executionId: execution.id,
          },
        });

      if (consumed.count !== 1) {
        throw new BadRequestException(
          'Approval could not be consumed because it was already used.',
        );
      }

      return execution;
    });
  }

  private async assertPending(
  approval: {
    id: string;
    merchantId: string;
    status: JarvisApprovalStatus;
    expiresAt: Date | null;
  },
): Promise<void> {
  if (
    approval.status !==
    JarvisApprovalStatus.PENDING
  ) {
    throw new BadRequestException(
      `Approval is already ${approval.status}.`,
    );
  }

  if (
    approval.expiresAt &&
    approval.expiresAt <= new Date()
  ) {
    await this.prisma.jarvisApproval.updateMany({
      where: {
        id: approval.id,
        merchantId: approval.merchantId,
        status: JarvisApprovalStatus.PENDING,
      },
      data: {
        status: JarvisApprovalStatus.EXPIRED,
        decidedAt: new Date(),
      },
    });

    throw new BadRequestException(
      'Approval has expired.',
    );
  }
}

  private jsonEqual(
    left: unknown,
    right: unknown,
  ): boolean {
    return JSON.stringify(left ?? null) ===
      JSON.stringify(right ?? null);
  }

  private toJson(
    value: unknown,
  ): Prisma.InputJsonValue | undefined {
    if (value === undefined) {
      return undefined;
    }

    try {
      return JSON.parse(
        JSON.stringify(value),
      ) as Prisma.InputJsonValue;
    } catch {
      throw new BadRequestException(
        'Approval arguments must be JSON serializable.',
      );
    }
  }
}
