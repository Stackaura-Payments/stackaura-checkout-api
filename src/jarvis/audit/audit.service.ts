import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, JarvisExecutionStatus } from '@prisma/client';

export interface StartAuditInput {
  merchantId: string;
  userId?: string;
  agent: string;
  toolId: string;
  intent: string;
  permission: string;
  approved?: boolean;
  request?: unknown;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async start(input: StartAuditInput) {
    return this.prisma.jarvisExecution.create({
      data: {
        merchantId: input.merchantId,
        userId: input.userId,
        agent: input.agent,
        toolId: input.toolId,
        intent: input.intent,
        permission: input.permission,
        approved: input.approved ?? false,
        status: JarvisExecutionStatus.STARTED,
        request: this.sanitize(input.request),
      },
    });
  }

  async succeed(id: string, result?: unknown) {
    return this.prisma.jarvisExecution.update({
      where: { id },
      data: {
        status: JarvisExecutionStatus.SUCCEEDED,
        result: this.sanitize(result),
        completedAt: new Date(),
      },
    });
  }

  async fail(id: string, error: unknown) {
    return this.prisma.jarvisExecution.update({
      where: { id },
      data: {
        status: JarvisExecutionStatus.FAILED,
        error: this.safeError(error),
        completedAt: new Date(),
      },
    });
  }

  async deny(input: StartAuditInput, error?: unknown) {
    return this.prisma.jarvisExecution.create({
      data: {
        merchantId: input.merchantId,
        userId: input.userId,
        agent: input.agent,
        toolId: input.toolId,
        intent: input.intent,
        permission: input.permission,
        approved: input.approved ?? false,
        status: JarvisExecutionStatus.DENIED,
        request: this.sanitize(input.request),
        error: error ? this.safeError(error) : 'Execution denied.',
        completedAt: new Date(),
      },
    });
  }

  async list(input: {
    merchantId: string;
    userId?: string;
    status?: JarvisExecutionStatus;
    agent?: string;
    toolId?: string;
    limit?: number;
  }) {
    const limit = Math.min(
      Math.max(input.limit ?? 25, 1),
      100,
    );

    return this.prisma.jarvisExecution.findMany({
      where: {
        merchantId: input.merchantId,
        ...(input.userId
          ? {
              userId: input.userId,
            }
          : {}),
        ...(input.status
          ? {
              status: input.status,
            }
          : {}),
        ...(input.agent
          ? {
              agent: input.agent,
            }
          : {}),
        ...(input.toolId
          ? {
              toolId: input.toolId,
            }
          : {}),
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
      select: {
        id: true,
        userId: true,
        agent: true,
        toolId: true,
        intent: true,
        permission: true,
        approved: true,
        status: true,
        request: true,
        result: true,
        error: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        approval: {
          select: {
            id: true,
            merchantId: true,
            userId: true,
            decidedByUserId: true,
            toolId: true,
            intent: true,
            status: true,
            requestedAt: true,
            decidedAt: true,
            expiresAt: true,
          },
        },
      },
    });
  }

  private sanitize(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) {
      return undefined;
    }

    try {
      const sanitized = JSON.parse(
        JSON.stringify(value, (key, currentValue) => {
          if (
            typeof currentValue === 'string' &&
            /password|secret|token|private.?key|api.?key/i.test(key)
          ) {
            return '[REDACTED]';
          }

          return currentValue;
        }),
      );

      return sanitized as Prisma.InputJsonValue;
    } catch {
      return {
        value: '[UNSERIALIZABLE]',
      };
    }
  }

  private safeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
