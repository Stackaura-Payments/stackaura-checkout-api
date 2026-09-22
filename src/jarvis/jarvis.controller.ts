import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { JarvisOwnerGuard } from './permissions/jarvis-owner.guard';
import type { SessionRequest } from '../auth/session-auth.guard';
import {
  JarvisAskInput,
  JarvisService,
} from './jarvis.service';
import { JarvisRuntimeContext } from './context/jarvis-runtime-context';
import { AuditService } from './audit/audit.service';
import { ApprovalService } from './approvals/approval.service';
import { ToolExecutor } from './tools/tool.executor';
import { JarvisExecutionStatus } from '@prisma/client';

@Controller('jarvis')
@UseGuards(SessionAuthGuard, JarvisOwnerGuard)
export class JarvisController {
  constructor(
    private readonly jarvisService: JarvisService,
    private readonly auditService: AuditService,
    private readonly approvalService: ApprovalService,
    private readonly toolExecutor: ToolExecutor,
  ) {}

  @Get('status')
  status(@Req() req: SessionRequest) {
    const context = this.getRuntimeContext(req);

    return {
      authenticated: true,
      authorized: true,
    };
  }

  @Post('ask')
  async ask(
    @Body() body: { message: string },
    @Req() req: SessionRequest,
  ) {
    const context = this.getRuntimeContext(req);

    const input: JarvisAskInput = {
      message: body.message,
      context,
    };

    return this.jarvisService.ask(input);
  }

  @Post('approvals')
  async createApproval(
    @Body()
    body: {
      toolId: string;
      intent: string;
      arguments?: unknown;
      expiresAt?: string;
    },
    @Req() req: SessionRequest,
  ) {
    const context = this.getRuntimeContext(req);

    let expiresAt: Date | undefined;

    if (body.expiresAt !== undefined) {
      const parsed = new Date(body.expiresAt);

      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException(
          'expiresAt must be a valid ISO date.',
        );
      }

      expiresAt = parsed;
    }

    const merchantId = this.requireMerchantResource(context);

    return this.approvalService.create({
      merchantId,
      userId: context.identity.userId,
      toolId: body.toolId,
      intent: body.intent,
      arguments: body.arguments,
      expiresAt,
    });
  }

  @Post('execute')
  async execute(
    @Body()
    body: {
      toolId: string;
      intent: string;
      arguments?: unknown;
      approvalId?: string;
    },
    @Req() req: SessionRequest,
  ) {
    const context = this.getRuntimeContext(req);

    return this.toolExecutor.execute(
      body.toolId,
      {
        ...context,
        agent: 'chief-of-staff',
        intent: body.intent,
        arguments: body.arguments,
        approvalId: body.approvalId,
      },
    );
  }

  @Get('approvals')
  async approvals(@Req() req: SessionRequest) {
    const context = this.getRuntimeContext(req);

    const merchantId = this.requireMerchantResource(context);

    return this.approvalService.getPending(merchantId);
  }

  @Post('approvals/:id/approve')
  async approve(
    @Req() req: SessionRequest,
    @Param('id') approvalId: string,
  ) {
    const context = this.getRuntimeContext(req);

    const merchantId = this.requireMerchantResource(context);

    return this.approvalService.approve(
      merchantId,
      approvalId,
      context.identity.userId,
    );
  }

  @Post('approvals/:id/deny')
  async deny(
    @Req() req: SessionRequest,
    @Param('id') approvalId: string,
  ) {
    const context = this.getRuntimeContext(req);

    const merchantId = this.requireMerchantResource(context);

    return this.approvalService.deny(
      merchantId,
      approvalId,
      context.identity.userId,
    );
  }


  private getRuntimeContext(
    req: SessionRequest,
  ): JarvisRuntimeContext {
    const userId = req.sessionAuth?.user?.id;

    if (!userId) {
      throw new UnauthorizedException(
        'No user context is available for this session.',
      );
    }

    const merchantId =
      req.sessionAuth?.memberships?.[0]?.merchant?.id;

    return {
      identity: {
        ownerId: userId,
        userId,
      },
      resource: merchantId
        ? {
            type: 'merchant',
            id: merchantId,
          }
        : undefined,
    };
  }

  private requireMerchantResource(
    context: JarvisRuntimeContext,
  ): string {
    if (
      !context.resource ||
      context.resource.type !== 'merchant' ||
      !context.resource.id
    ) {
      throw new UnauthorizedException(
        'No merchant resource is available for this operation.',
      );
    }

    return context.resource.id;
  }

  @Get('executions')
  async executions(
    @Req() req: SessionRequest,
    @Query('status') status?: string,
    @Query('agent') agent?: string,
    @Query('toolId') toolId?: string,
    @Query('limit') limit?: string,
  ) {
    const context = this.getRuntimeContext(req);
    const merchantId = this.requireMerchantResource(context);

    const parsedLimit =
  limit !== undefined
    ? Number.parseInt(limit, 10)
    : undefined;

if (
  limit !== undefined &&
  parsedLimit !== undefined &&
  (!Number.isInteger(parsedLimit) || parsedLimit < 1)
) {
  throw new BadRequestException(
    'limit must be a positive integer.',
  );
}

let parsedStatus: JarvisExecutionStatus | undefined;

if (status !== undefined) {
  if (
    !Object.values(JarvisExecutionStatus).includes(
      status as JarvisExecutionStatus,
    )
  ) {
    throw new BadRequestException(
      `Invalid status. Expected one of: ${Object.values(
        JarvisExecutionStatus,
      ).join(', ')}`,
    );
  }

  parsedStatus = status as JarvisExecutionStatus;
}

return this.auditService.list({
  merchantId,
  status: parsedStatus,
  agent,
  toolId,
  limit: parsedLimit,
});
  }
}
