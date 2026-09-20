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
import { JarvisOwnerGuard } from './permissions/jarvis-owner.guard';

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
    JarvisOwnerGuard,
  ],
  exports: [JarvisService],
})
export class JarvisModule {}
