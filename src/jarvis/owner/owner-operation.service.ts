import { Injectable } from '@nestjs/common';
import { JarvisOwnerOperationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StartOwnerOperationInput } from './owner-operation.types';

@Injectable()
export class OwnerOperationService {
  constructor(private readonly prisma: PrismaService) {}

  async start(input: StartOwnerOperationInput) {
    return this.prisma.jarvisOwnerOperation.create({
      data: {
        ownerId: input.ownerId,
        userId: input.userId,
        agent: input.agent,
        toolId: input.toolId,
        intent: input.intent,
        permission: input.permission,
        approved: input.approved ?? false,
        status: JarvisOwnerOperationStatus.STARTED,
        request: this.sanitize(input.request),
      },
    });
  }

  async succeed(id: string, result?: unknown) {
    return this.prisma.jarvisOwnerOperation.update({
      where: { id },
      data: {
        status: JarvisOwnerOperationStatus.SUCCEEDED,
        result: this.sanitize(result),
        completedAt: new Date(),
      },
    });
  }

  async fail(id: string, error: unknown) {
    return this.prisma.jarvisOwnerOperation.update({
      where: { id },
      data: {
        status: JarvisOwnerOperationStatus.FAILED,
        error: this.safeError(error),
        completedAt: new Date(),
      },
    });
  }

  async deny(input: StartOwnerOperationInput, error?: unknown) {
    return this.prisma.jarvisOwnerOperation.create({
      data: {
        ownerId: input.ownerId,
        userId: input.userId,
        agent: input.agent,
        toolId: input.toolId,
        intent: input.intent,
        permission: input.permission,
        approved: input.approved ?? false,
        status: JarvisOwnerOperationStatus.DENIED,
        request: this.sanitize(input.request),
        error: error ? this.safeError(error) : 'Operation denied.',
        completedAt: new Date(),
      },
    });
  }

  async list(input: {
    ownerId: string;
    userId?: string;
    status?: JarvisOwnerOperationStatus;
    agent?: string;
    toolId?: string;
    limit?: number;
  }) {
    // Operational History is a compact live feed: exactly the five newest audits.
    // The durable owner-operation records remain unchanged.
    const limit = 5;

    return this.prisma.jarvisOwnerOperation.findMany({
      where: {
        ownerId: input.ownerId,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.toolId ? { toolId: input.toolId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  private sanitize(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) return undefined;

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
      return { value: '[UNSERIALIZABLE]' };
    }
  }

  private safeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
