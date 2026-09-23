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
import { OwnerApprovalService } from './approvals/owner-approval.service';
import { ToolExecutor } from './tools/tool.executor';
import { OwnerToolExecutor } from './owner/owner-tool.executor';
import { OwnerOperationService } from './owner/owner-operation.service';
import { ActionLifecycleService } from './owner/action-lifecycle.service';
import { EngineeringRepairWorkflowService } from './engineering/engineering-repair-workflow.service';
import { AgentRegistry } from './agents/agent.registry';
import { JarvisActionStatus, JarvisExecutionStatus, JarvisOwnerOperationStatus } from '@prisma/client';

@Controller('jarvis')
@UseGuards(SessionAuthGuard, JarvisOwnerGuard)
export class JarvisController {
  constructor(
    private readonly jarvisService: JarvisService,
    private readonly auditService: AuditService,
    private readonly approvalService: ApprovalService,
    private readonly ownerApprovalService: OwnerApprovalService,
    private readonly toolExecutor: ToolExecutor,
    private readonly ownerToolExecutor: OwnerToolExecutor,
    private readonly ownerOperationService: OwnerOperationService,
    private readonly actionLifecycleService: ActionLifecycleService,
    private readonly engineeringRepairWorkflowService: EngineeringRepairWorkflowService,
    private readonly agentRegistry: AgentRegistry,
  ) {}

  @Get('status')
  status(@Req() req: SessionRequest) {
    const context = this.getRuntimeContext(req);

    return {
      authenticated: true,
      authorized: true,
    };
  }

  @Get('agents')
  agents() {
    return this.agentRegistry.list().map((agent) => ({
      ...agent,
      capabilities: [...agent.capabilities],
    }));
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

  @Post('owner/engineering/repairs')
  async startEngineeringRepair(
    @Body() body: {
      repository: string;
      commitSha: string;
      relevantFiles?: string[];
      failureSignature?: string;
      projectId?: string;
      failureDomain?: 'dependency-installation' | 'build' | 'runtime' | 'configuration' | 'unknown';
      previousKnownGoodCommit?: string | null;
      diagnosis?: import('./engineering/engineering-diagnostic.types').EngineeringDiagnosis;
    },
    @Req() req: SessionRequest,
  ) {
    const context = this.getRuntimeContext(req);
    const repair = await this.engineeringRepairWorkflowService.start({
      ownerId: context.identity.ownerId,
      requestedByUserId: context.identity.userId,
      repository: body.repository,
      commitSha: body.commitSha,
      relevantFiles: body.relevantFiles ?? [],
      failureSignature: body.failureSignature,
      projectId: body.projectId,
      failureDomain: body.failureDomain,
      previousKnownGoodCommit: body.previousKnownGoodCommit,
      diagnosis: body.diagnosis,
    });
    const action = await this.actionLifecycleService.propose({
      ownerId: context.identity.ownerId,
      requestedByUserId: context.identity.userId,
      toolId: 'jarvis.owner.engineering.repair',
      intent: 'execute-engineering-repair-' + repair.id,
      arguments: { repairId: repair.id },
      riskLevel: 'CRITICAL',
    });
    await this.engineeringRepairWorkflowService.attachApproval(
      context.identity.ownerId,
      repair.id,
      action.action.id,
    );
    return { repairId: repair.id, repair, action: action.action, approval: action.approval };
  }

  @Post('owner/engineering/repairs/from-diagnosis')
  async startEngineeringRepairFromDiagnosis(
    @Body() body: {
      diagnosis: import('./engineering/engineering-diagnostic.types').EngineeringDiagnosis;
    },
    @Req() req: SessionRequest,
  ) {
    const context = this.getRuntimeContext(req);
    const diagnosis = body.diagnosis;
    if (!diagnosis?.deployment?.commitSha || !diagnosis.sourceAnalysis?.repository) {
      throw new BadRequestException('A complete engineering diagnosis with repository and deployed commit is required.');
    }
    if (diagnosis.remediation.actions.every((action) => action.toolId !== 'jarvis.owner.github.update-file')) {
      throw new BadRequestException('The diagnosis does not contain an approval-gated source update remediation.');
    }
    const repair = await this.engineeringRepairWorkflowService.start({
      ownerId: context.identity.ownerId,
      requestedByUserId: context.identity.userId,
      repository: diagnosis.sourceAnalysis.repository,
      commitSha: diagnosis.deployment.commitSha,
      relevantFiles: diagnosis.sourceAnalysis.relevantFiles,
      failureSignature: diagnosis.deployment.errorMessage ?? diagnosis.deployment.errorCode ?? undefined,
      projectId: process.env.VERCEL_PROJECT_ID,
      failureDomain: diagnosis.diagnosis.category as 'dependency-installation' | 'build' | 'runtime' | 'configuration' | 'unknown',
      previousKnownGoodCommit: diagnosis.sourceAnalysis.previousKnownGoodCommit,
      diagnosis,
    });
    const action = await this.actionLifecycleService.propose({
      ownerId: context.identity.ownerId,
      requestedByUserId: context.identity.userId,
      toolId: 'jarvis.owner.engineering.repair',
      intent: 'execute-diagnosed-engineering-repair-' + repair.id,
      arguments: { repairId: repair.id },
      riskLevel: 'CRITICAL',
    });
    await this.engineeringRepairWorkflowService.attachApproval(
      context.identity.ownerId,
      repair.id,
      action.action.id,
    );
    return { repairId: repair.id, repair, action: action.action, approval: action.approval };
  }

  @Get('owner/engineering/repairs')
  async engineeringRepairs(@Req() req: SessionRequest, @Query('limit') limit?: string) {
    const context = this.getRuntimeContext(req);
    const parsedLimit = limit === undefined ? 25 : Number.parseInt(limit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new BadRequestException('limit must be a positive integer.');
    }
    return this.engineeringRepairWorkflowService.list(context.identity.ownerId, parsedLimit);
  }

  @Get('owner/engineering/repairs/:id')
  async engineeringRepair(@Req() req: SessionRequest, @Param('id') repairId: string) {
    const context = this.getRuntimeContext(req);
    return this.engineeringRepairWorkflowService.get(context.identity.ownerId, repairId);
  }

  @Post('owner/actions/propose')
  async proposeOwnerAction(
    @Body() body: {
      toolId: string;
      intent: string;
      arguments?: unknown;
      riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      expiresAt?: string;
    },
    @Req() req: SessionRequest,
  ) {
    const context = this.getRuntimeContext(req);
    let expiresAt: Date | undefined;
    if (body.expiresAt !== undefined) {
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        throw new BadRequestException('expiresAt must be a valid ISO date.');
      }
    }
    return this.actionLifecycleService.propose({
      ownerId: context.identity.ownerId,
      requestedByUserId: context.identity.userId,
      toolId: body.toolId,
      intent: body.intent,
      arguments: body.arguments,
      riskLevel: body.riskLevel,
      expiresAt,
    });
  }

  @Get('owner/actions')
  async ownerActions(
    @Req() req: SessionRequest,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const context = this.getRuntimeContext(req);
    let parsedStatus: JarvisActionStatus | undefined;
    if (status !== undefined) {
      if (!Object.values(JarvisActionStatus).includes(status as JarvisActionStatus)) {
        throw new BadRequestException('Invalid JARVIS action status.');
      }
      parsedStatus = status as JarvisActionStatus;
    }
    const parsedLimit = limit === undefined ? 25 : Number.parseInt(limit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new BadRequestException('limit must be a positive integer.');
    }
    return this.actionLifecycleService.list(context.identity.ownerId, parsedStatus, parsedLimit);
  }

  @Get('owner/actions/:id')
  async ownerAction(@Req() req: SessionRequest, @Param('id') actionId: string) {
    const context = this.getRuntimeContext(req);
    return this.actionLifecycleService.get(context.identity.ownerId, actionId);
  }

  @Post('owner/actions/:id/approve')
  async approveOwnerAction(@Req() req: SessionRequest, @Param('id') actionId: string) {
    const context = this.getRuntimeContext(req);
    return this.actionLifecycleService.approve(context.identity.ownerId, actionId, context.identity.userId);
  }

  @Post('owner/actions/:id/deny')
  async denyOwnerAction(@Req() req: SessionRequest, @Param('id') actionId: string) {
    const context = this.getRuntimeContext(req);
    return this.actionLifecycleService.deny(context.identity.ownerId, actionId, context.identity.userId);
  }

  @Post('owner/actions/:id/execute')
  async executeOwnerAction(@Req() req: SessionRequest, @Param('id') actionId: string) {
    const context = this.getRuntimeContext(req);
    return this.actionLifecycleService.execute(context.identity.ownerId, actionId, context.identity.userId);
  }

  @Post('owner/actions/:id/resume')
  async resumeOwnerAction(@Req() req: SessionRequest, @Param('id') actionId: string) {
    const context = this.getRuntimeContext(req);
    return this.actionLifecycleService.resume(context.identity.ownerId, actionId, context.identity.userId);
  }

  @Post('owner/actions/:id/verify')
  async verifyOwnerAction(
    @Req() req: SessionRequest,
    @Param('id') actionId: string,
    @Body() body: { result?: unknown },
  ) {
    const context = this.getRuntimeContext(req);
    return this.actionLifecycleService.verify(context.identity.ownerId, actionId, body.result);
  }

  @Post('owner/actions/:id/recover')
  async recoverOwnerAction(
    @Req() req: SessionRequest,
    @Param('id') actionId: string,
    @Body() body: {
      toolId: string;
      intent: string;
      arguments?: unknown;
      riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    },
  ) {
    const context = this.getRuntimeContext(req);
    return this.actionLifecycleService.proposeRecovery({
      ownerId: context.identity.ownerId,
      requestedByUserId: context.identity.userId,
      actionId,
      toolId: body.toolId,
      intent: body.intent,
      arguments: body.arguments,
      riskLevel: body.riskLevel,
    });
  }

  @Post('owner/approvals')
  async createOwnerApproval(
    @Body()
    body: {
      toolId: string;
      intent: string;
      arguments?: unknown;
      riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      expiresAt?: string;
    },
    @Req() req: SessionRequest,
  ) {
    const context = this.getRuntimeContext(req);
    let expiresAt: Date | undefined;

    if (body.expiresAt !== undefined) {
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('expiresAt must be a valid ISO date.');
      }
      expiresAt = parsed;
    }

    return this.ownerApprovalService.create({
      ownerId: context.identity.ownerId,
      requestedByUserId: context.identity.userId,
      toolId: body.toolId,
      intent: body.intent,
      arguments: body.arguments,
      riskLevel: body.riskLevel,
      expiresAt,
    });
  }

  @Get('owner/approvals')
  async ownerApprovals(@Req() req: SessionRequest) {
    const context = this.getRuntimeContext(req);
    return this.ownerApprovalService.getPending(context.identity.ownerId);
  }

  @Post('owner/approvals/:id/approve')
  async approveOwnerApproval(
    @Req() req: SessionRequest,
    @Param('id') approvalId: string,
  ) {
    const context = this.getRuntimeContext(req);
    return this.ownerApprovalService.approve(
      context.identity.ownerId,
      approvalId,
      context.identity.userId,
    );
  }

  @Post('owner/approvals/:id/deny')
  async denyOwnerApproval(
    @Req() req: SessionRequest,
    @Param('id') approvalId: string,
  ) {
    const context = this.getRuntimeContext(req);
    return this.ownerApprovalService.deny(
      context.identity.ownerId,
      approvalId,
      context.identity.userId,
    );
  }

  @Get('owner/operations')
  async ownerOperations(
    @Req() req: SessionRequest,
    @Query('status') status?: string,
    @Query('agent') agent?: string,
    @Query('toolId') toolId?: string,
    @Query('limit') limit?: string,
  ) {
    const context = this.getRuntimeContext(req);
    const parsedLimit = limit === undefined ? undefined : Number.parseInt(limit, 10);

    if (limit !== undefined && (parsedLimit === undefined || !Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException('limit must be a positive integer.');
    }

    let parsedStatus: JarvisOwnerOperationStatus | undefined;
    if (status !== undefined) {
      if (!Object.values(JarvisOwnerOperationStatus).includes(status as JarvisOwnerOperationStatus)) {
        throw new BadRequestException('Invalid owner operation status.');
      }
      parsedStatus = status as JarvisOwnerOperationStatus;
    }

    const operations = await this.ownerOperationService.list({
      ownerId: context.identity.ownerId,
      userId: context.identity.userId,
      status: parsedStatus,
      agent,
      toolId,
      limit: parsedLimit,
    });

    return operations.map((operation) => ({
      id: operation.id,
      agent: operation.agent,
      toolId: operation.toolId,
      intent: operation.intent,
      permission: operation.permission,
      scope: 'OWNER' as const,
      mode: 'READ ONLY' as const,
      approved: operation.approved,
      status: operation.status,
      startedAt: operation.startedAt,
      completedAt: operation.completedAt,
      createdAt: operation.createdAt,
      error: operation.error,
    }));
  }

  @Post('owner/execute')
  async executeOwner(
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

    return this.ownerToolExecutor.execute(
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
