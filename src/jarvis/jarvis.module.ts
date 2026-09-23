import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommandCenterModule } from '../command-center/command-center.module';
import { AgentRegistry } from './agents/agent.registry';
import { JarvisController } from './jarvis.controller';
import { JarvisService } from './jarvis.service';
import { MemoryService } from './memory/memory.service';
import { PermissionService } from './permissions/permission.service';
import { ToolRegistry } from './tools/tool.registry';
import { ToolExecutor } from './tools/tool.executor';
import { AuditService } from './audit/audit.service';
import { ApprovalService } from './approvals/approval.service';
import { OwnerApprovalService } from './approvals/owner-approval.service';
import { JarvisOwnerGuard } from './permissions/jarvis-owner.guard';
import { PlannerService } from './orchestration/planner.service';
import { OrchestratorService } from './orchestration/orchestrator.service';
import { OwnerOperationService } from './owner/owner-operation.service';
import { OwnerToolExecutor } from './owner/owner-tool.executor';
import { GitHubOwnerService } from './owner/github-owner.service';
import { VercelOwnerService } from './owner/vercel-owner.service';
import { ActionLifecycleService } from './owner/action-lifecycle.service';
import { EngineeringDiagnosticService } from './engineering/engineering-diagnostic.service';
import { EngineeringSourceInspectionService } from './engineering/engineering-source-inspection.service';
import { EngineeringRepairWorkflowService } from './engineering/engineering-repair-workflow.service';
import { PaymentsAgentService } from './payments/payments-agent.service';

@Module({
  imports: [
    AuthModule,
    CommandCenterModule,
  ],
  controllers: [JarvisController],
  providers: [
    JarvisService,
    AgentRegistry,
    ToolRegistry,
    ToolExecutor,
    MemoryService,
    PermissionService,
    AuditService,
    ApprovalService,
    OwnerApprovalService,
    JarvisOwnerGuard,
    PlannerService,
    OrchestratorService,
    OwnerOperationService,
    OwnerToolExecutor,
    GitHubOwnerService,
    VercelOwnerService,
    ActionLifecycleService,
    EngineeringDiagnosticService,
    EngineeringSourceInspectionService,
    EngineeringRepairWorkflowService,
    PaymentsAgentService,
  ],
  exports: [JarvisService],
})
export class JarvisModule {}
