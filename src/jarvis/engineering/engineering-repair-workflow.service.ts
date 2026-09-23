import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { JarvisRepairStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubOwnerService } from '../owner/github-owner.service';
import { VercelOwnerService } from '../owner/vercel-owner.service';
import { EngineeringSourceInspectionService, SourceFileFix } from './engineering-source-inspection.service';
import { EngineeringDiagnosis } from './engineering-diagnostic.types';

export interface StartRepairInput {
  ownerId: string;
  requestedByUserId: string;
  repository: string;
  commitSha: string;
  relevantFiles: string[];
  failureSignature?: string;
  projectId?: string;
  failureDomain?: 'dependency-installation' | 'build' | 'runtime' | 'configuration' | 'unknown';
  previousKnownGoodCommit?: string | null;
  diagnosis?: EngineeringDiagnosis;
}

export interface RepairWorkflowPlan {
  repository: string;
  baseCommit: string;
  previousKnownGoodCommit: string | null;
  branchName: string;
  fixes: Array<{ path: string; content: string; sha: string; message: string }>;
  failureSignature: string | null;
  projectId: string;
}

@Injectable()
export class EngineeringRepairWorkflowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngineeringRepairWorkflowService.name);
  private readonly activeRepairs = new Set<string>();
  private recoverySweepTimer?: NodeJS.Timeout;
  private readonly leaseMs = Math.max(30_000, Number.parseInt(process.env.JARVIS_REPAIR_LEASE_MS ?? '90_000', 10));
  private readonly recoverySweepMs = Math.max(10_000, Number.parseInt(process.env.JARVIS_REPAIR_RECOVERY_SWEEP_MS ?? '30_000', 10));
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubOwnerService,
    private readonly vercel: VercelOwnerService,
    private readonly source: EngineeringSourceInspectionService,
  ) {}
  async start(input: StartRepairInput) {
    if (input.ownerId !== input.requestedByUserId) {
      throw new BadRequestException(
        'JARVIS repair requires the authenticated owner identity.',
      );
    }
    if (!input.commitSha.trim())
      throw new BadRequestException('commitSha is required.');
    const inspection = input.diagnosis
      ? this.inspectionFromDiagnosis(input.diagnosis)
      : await this.source.inspect(
          input.repository,
          input.commitSha,
          input.relevantFiles.slice(0, 20),
          input.previousKnownGoodCommit,
          input.failureDomain ?? 'unknown',
        );
    if (!inspection.fixes.length) {
      throw new BadRequestException(
        'No safe exact source fix was generated for this repair.',
      );
    }

    const branchName =
      'jarvis/repair/' +
      input.commitSha.slice(0, 8) +
      '-' +
      Date.now().toString(36);
    const plan: RepairWorkflowPlan = {
      repository: input.repository,
      baseCommit: input.commitSha,
      previousKnownGoodCommit: inspection.previousKnownGoodCommit,
      branchName,
      fixes: inspection.fixes,
      failureSignature: input.failureSignature ?? null,
      projectId: input.projectId ?? process.env.VERCEL_PROJECT_ID ?? '',
    };
    if (!plan.projectId) {
      throw new BadRequestException(
        'Vercel projectId is required for this repair workflow.',
      );
    }

    return this.prisma.jarvisEngineeringRepair.create({
      data: {
        ownerId: input.ownerId,
        requestedByUserId: input.requestedByUserId,
        repository: plan.repository,
        baseCommit: plan.baseCommit,
        previousKnownGoodCommit: plan.previousKnownGoodCommit,
        branchName: plan.branchName,
        status: JarvisRepairStatus.PENDING_APPROVAL,
        plan: this.toJson(plan),
        diagnosis: this.toJson({
          failureSignature: plan.failureSignature,
          findings: inspection.findings,
        }),
      },
    });
  }

  private inspectionFromDiagnosis(diagnosis: EngineeringDiagnosis) {
    const updateActions = diagnosis.remediation.actions.filter(
      (action) => action.toolId === 'jarvis.owner.github.update-file',
    );
    const fixes: SourceFileFix[] = updateActions.flatMap((action) => {
      const args = action.arguments;
      if (
        typeof args.path !== 'string' ||
        typeof args.content !== 'string' ||
        typeof args.sha !== 'string' ||
        typeof args.message !== 'string'
      ) return [];
      return [{ path: args.path, content: args.content, sha: args.sha, message: args.message }];
    });
    return {
      previousKnownGoodCommit: diagnosis.sourceAnalysis.previousKnownGoodCommit,
      failureDomain: diagnosis.diagnosis.category as any,
      rootCause: diagnosis.diagnosis.rootCause,
      confidence: diagnosis.diagnosis.confidence,
      exactFix: diagnosis.remediation.exactFix,
      fileComparisons: diagnosis.sourceAnalysis.fileComparisons,
      findings: diagnosis.sourceAnalysis.findings,
      fixes,
    };
  }

  async attachApproval(ownerId: string, repairId: string, actionId: string) {
    const repair = await this.get(ownerId, repairId);
    return this.prisma.jarvisEngineeringRepair.update({
      where: { id: repair.id },
      data: { actionId },
    });
  }
  async get(ownerId: string, repairId: string) {
    const repair = await this.prisma.jarvisEngineeringRepair.findFirst({
      where: { id: repairId, ownerId },
    });
    if (!repair)
      throw new NotFoundException('JARVIS engineering repair was not found.');
    return repair;
  }

  async list(ownerId: string, limit = 25) {
    return this.prisma.jarvisEngineeringRepair.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async onModuleInit() {
    void this.resumeActiveRepairs();
    this.recoverySweepTimer = setInterval(() => {
      void this.resumeActiveRepairs();
    }, this.recoverySweepMs);
  }

  onModuleDestroy() {
    if (this.recoverySweepTimer) clearInterval(this.recoverySweepTimer);
  }

  private async resumeActiveRepairs() {
    try {
      const repairs = await this.prisma.jarvisEngineeringRepair.findMany({
        where: {
          status: {
            in: [
              JarvisRepairStatus.APPROVED,
              JarvisRepairStatus.BRANCHING,
              JarvisRepairStatus.APPLYING_FIX,
              JarvisRepairStatus.VERIFYING_CI,
              JarvisRepairStatus.READY_TO_DEPLOY,
              JarvisRepairStatus.DEPLOYING,
              JarvisRepairStatus.VERIFYING_DEPLOYMENT,
            ],
          },
        },
        orderBy: { updatedAt: 'asc' },
        take: 20,
      });
      for (const repair of repairs) {
        void this.execute(repair.ownerId, repair.id).catch((error) => {
          this.logger.error(
            'Repair resume failed for ' + repair.id + ': ' + String(error),
          );
        });
      }
    } catch (error) {
      this.logger.error(
        'Unable to scan resumable engineering repairs: ' + String(error),
      );
    }
  }

  async execute(ownerId: string, repairId: string) {
    if (this.activeRepairs.has(repairId)) return this.get(ownerId, repairId);
    const lease = await this.claimLease(ownerId, repairId);
    if (!lease) return this.get(ownerId, repairId);
    this.activeRepairs.add(repairId);

    try {
      return await this.executeResumable(ownerId, repairId, lease);
    } finally {
      this.activeRepairs.delete(repairId);
      await this.releaseLease(repairId, lease).catch((error) =>
        this.logger.warn('Unable to release repair lease ' + repairId + ': ' + String(error)),
      );
    }
  }

  private async executeResumable(ownerId: string, repairId: string, leaseId: string) {
    let repair = await this.get(ownerId, repairId);
    await this.heartbeat(repairId, leaseId);
    if (
      repair.status === JarvisRepairStatus.SUCCEEDED ||
      repair.status === JarvisRepairStatus.FAILED ||
      repair.status === JarvisRepairStatus.RECOVERY_REQUIRED ||
      repair.status === JarvisRepairStatus.DENIED
    ) {
      return repair;
    }
    if (repair.status === JarvisRepairStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        'Repair requires owner approval before execution.',
      );
    }

    const plan = this.requirePlan(repair.plan);

    try {
      if (
        repair.status === JarvisRepairStatus.APPROVED ||
        repair.status === JarvisRepairStatus.BRANCHING
      ) {
        await this.ensureLease(repairId, leaseId);
        await this.ensureBranch(plan);
        await this.heartbeat(repairId, leaseId);
        repair = await this.transition(
          repair.id,
          JarvisRepairStatus.APPLYING_FIX,
          leaseId,
        );
      }

      if (repair.status === JarvisRepairStatus.APPLYING_FIX) {
        let currentCommit = repair.currentCommitSha ?? plan.baseCommit;
        const applied = this.persistedApplied(repair.verification);

        for (const fix of plan.fixes) {
          const existing = await this.safeGetFile(
            plan.repository,
            fix.path,
            plan.branchName,
          );
          if (existing?.content === fix.content) {
            applied.add(fix.path);
            currentCommit = await this.github.getBranch(
              plan.repository,
              plan.branchName,
            );
            await this.persistProgress(repair.id, currentCommit, [...applied], leaseId);
            await this.heartbeat(repair.id, leaseId);
            continue;
          }

          const result = await this.github.updateFile({
            repositoryFullName: plan.repository,
            path: fix.path,
            content: fix.content,
            message: fix.message,
            sha: existing?.sha ?? fix.sha,
            branch: plan.branchName,
          });
          currentCommit =
            this.resultString(result, 'commitSha', 'sha') ||
            (await this.github.getBranch(plan.repository, plan.branchName));
          applied.add(fix.path);
          await this.persistProgress(repair.id, currentCommit, [...applied], leaseId);
          await this.heartbeat(repair.id, leaseId);
        }

        await this.ensureLease(repair.id, leaseId);
        const stageUpdate = await this.prisma.jarvisEngineeringRepair.updateMany({
          where: { id: repair.id, executionLeaseId: leaseId },
          data: {
            currentCommitSha: currentCommit,
            verification: this.toJson({ applied: [...applied] }),
            status: JarvisRepairStatus.VERIFYING_CI,
          },
        });
        if (stageUpdate.count !== 1) throw new BadRequestException('Repair execution lease was lost.');
        repair = await this.getById(repair.id);
      }

      if (repair.status === JarvisRepairStatus.VERIFYING_CI) {
        const commitSha =
          repair.currentCommitSha ??
          (await this.github.getBranch(plan.repository, plan.branchName));
        const ci = await this.waitForCi(plan.repository, commitSha, repair.id, leaseId);
        await this.ensureLease(repair.id, leaseId);
        const ciUpdate = await this.prisma.jarvisEngineeringRepair.updateMany({
          where: { id: repair.id, executionLeaseId: leaseId },
          data: { currentCommitSha: commitSha, ciVerification: this.toJson(ci) },
        });
        if (ciUpdate.count !== 1) throw new BadRequestException('Repair execution lease was lost.');
        if (!ci.verified) {
          await this.fail(repair.id, 'GitHub CI/check verification failed.', {
            ci,
          }, leaseId);
          throw new BadRequestException('GitHub CI/check verification failed.');
        }
        repair = await this.transition(
          repair.id,
          JarvisRepairStatus.READY_TO_DEPLOY,
          leaseId,
        );
      }

      if (repair.status === JarvisRepairStatus.READY_TO_DEPLOY) {
        repair = await this.transition(repair.id, JarvisRepairStatus.DEPLOYING, leaseId);
      }

      if (repair.status === JarvisRepairStatus.DEPLOYING) {
        let deploymentId = this.persistedDeploymentId(repair.deployment);
        if (!deploymentId) {
          const existing = await this.vercel.listDeployments(50);
          const match = existing.find(
            (deployment) =>
              deployment.branch === plan.branchName &&
              deployment.target === 'production',
          );
          deploymentId = match?.id ?? null;
        }
        if (!deploymentId) {
          const deployment = await this.vercel.deploy({
            projectId: plan.projectId,
            target: 'production',
            ref: plan.branchName,
          });
          deploymentId = this.resultString(deployment, 'id', 'uid');
        }

        await this.ensureLease(repair.id, leaseId);
        const deploymentUpdate = await this.prisma.jarvisEngineeringRepair.updateMany({
          where: { id: repair.id, executionLeaseId: leaseId },
          data: { deployment: this.toJson({ deploymentId, branch: plan.branchName }), status: JarvisRepairStatus.VERIFYING_DEPLOYMENT },
        });
        if (deploymentUpdate.count !== 1) throw new BadRequestException('Repair execution lease was lost.');
        repair = await this.getById(repair.id);
      }

      if (repair.status === JarvisRepairStatus.VERIFYING_DEPLOYMENT) {
        const deploymentId = this.persistedDeploymentId(repair.deployment);
        if (!deploymentId)
          throw new BadRequestException(
            'Persisted deployment identity is missing.',
          );
        const verification = await this.waitForDeployment(
          deploymentId,
          plan.failureSignature,
          repair.id,
          leaseId,
        );
        await this.ensureLease(repair.id, leaseId);
        const verificationUpdate = await this.prisma.jarvisEngineeringRepair.updateMany({
          where: { id: repair.id, executionLeaseId: leaseId },
          data: { verification: this.toJson(verification) },
        });
        if (verificationUpdate.count !== 1) throw new BadRequestException('Repair execution lease was lost.');
        if (!verification.verified) {
          await this.fail(repair.id, 'Deployment verification failed.', {
            verification,
          }, leaseId);
          throw new BadRequestException('Deployment verification failed.');
        }
        const successUpdate = await this.prisma.jarvisEngineeringRepair.updateMany({
          where: { id: repair.id, executionLeaseId: leaseId },
          data: { status: JarvisRepairStatus.SUCCEEDED, completedAt: new Date() },
        });
        if (successUpdate.count !== 1) throw new BadRequestException('Repair execution lease was lost.');
        return this.getById(repair.id);
      }

      return this.get(ownerId, repairId);
    } catch (error) {
      const latest = await this.get(ownerId, repairId);
      if (
        latest.status !== JarvisRepairStatus.FAILED &&
        latest.status !== JarvisRepairStatus.SUCCEEDED
      ) {
        await this.fail(
          repair.id,
          error instanceof Error ? error.message : String(error),
          undefined,
          leaseId,
        );
      }
      throw error;
    }
  }

  private async ensureBranch(plan: RepairWorkflowPlan) {
    try {
      await this.github.getBranch(plan.repository, plan.branchName);
    } catch {
      await this.github.createBranch({
        repositoryFullName: plan.repository,
        branchName: plan.branchName,
        sha: plan.baseCommit,
      });
    }
  }

  private async safeGetFile(repository: string, path: string, ref: string) {
    try {
      return await this.github.getFile(repository, path, ref);
    } catch {
      return null;
    }
  }

  private persistedApplied(value: unknown): Set<string> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return new Set();
    const applied = (value as Record<string, unknown>).applied;
    return new Set(
      Array.isArray(applied)
        ? applied.filter((item): item is string => typeof item === 'string')
        : [],
    );
  }

  private async persistProgress(
    id: string,
    commitSha: string,
    applied: string[],
    leaseId: string,
  ) {
    const result = await this.prisma.jarvisEngineeringRepair.updateMany({
      where: { id, executionLeaseId: leaseId },
      data: {
        currentCommitSha: commitSha,
        verification: this.toJson({ applied }),
        lastHeartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + this.leaseMs),
      },
    });
    if (result.count !== 1) throw new BadRequestException('Repair execution lease was lost.');
  }

  private async claimLease(ownerId: string, repairId: string): Promise<string | null> {
    const leaseId = randomUUID();
    const now = new Date();
    const result = await this.prisma.jarvisEngineeringRepair.updateMany({
      where: {
        id: repairId,
        ownerId,
        status: { notIn: [JarvisRepairStatus.PENDING_APPROVAL, JarvisRepairStatus.SUCCEEDED, JarvisRepairStatus.FAILED, JarvisRepairStatus.RECOVERY_REQUIRED, JarvisRepairStatus.DENIED] },
        OR: [{ executionLeaseId: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: {
        executionLeaseId: leaseId,
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
        lastHeartbeatAt: now,
        attemptCount: { increment: 1 },
        startedAt: { set: now },
      },
    });
    return result.count === 1 ? leaseId : null;
  }

  private async heartbeat(id: string, leaseId: string) {
    const result = await this.prisma.jarvisEngineeringRepair.updateMany({
      where: { id, executionLeaseId: leaseId },
      data: { lastHeartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + this.leaseMs) },
    });
    if (result.count !== 1) throw new BadRequestException('Repair execution lease was lost.');
  }

  private async ensureLease(id: string, leaseId: string) {
    const repair = await this.prisma.jarvisEngineeringRepair.findFirst({ where: { id, executionLeaseId: leaseId } });
    if (!repair) throw new BadRequestException('Repair execution lease was lost.');
    if (!repair.leaseExpiresAt || repair.leaseExpiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Repair execution lease expired.');
    }
  }

  private async releaseLease(id: string, leaseId: string) {
    await this.prisma.jarvisEngineeringRepair.updateMany({
      where: { id, executionLeaseId: leaseId },
      data: { executionLeaseId: null, leaseExpiresAt: null, lastHeartbeatAt: new Date() },
    });
  }

  private persistedDeploymentId(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const id = (value as Record<string, unknown>).deploymentId;
    return typeof id === 'string' && id.trim() ? id : null;
  }

  private async waitForCi(repository: string, commitSha: string, repairId: string, leaseId: string) {
    const attempts = Number.parseInt(
      process.env.JARVIS_REPAIR_CI_POLLS ?? '12',
      10,
    );
    const delayMs = Number.parseInt(
      process.env.JARVIS_REPAIR_CI_POLL_MS ?? '5000',
      10,
    );
    let latest: Record<string, unknown> = {
      verified: false,
      status: 'not-started',
    };
    for (let i = 0; i < Math.max(attempts, 1); i++) {
      latest = await this.github.getCommitVerification(repository, commitSha);
      await this.heartbeat(repairId, leaseId);
      if (latest.verified === true || latest.failed === true) return latest;
      if (i < attempts - 1) await this.sleep(delayMs);
    }
    return latest;
  }

  private async waitForDeployment(
    deploymentId: string,
    failureSignature: string | null,
    repairId: string,
    leaseId: string,
  ) {
    const attempts = Number.parseInt(
      process.env.JARVIS_REPAIR_DEPLOY_POLLS ?? '12',
      10,
    );
    const delayMs = Number.parseInt(
      process.env.JARVIS_REPAIR_DEPLOY_POLL_MS ?? '5000',
      10,
    );
    let latest: Record<string, unknown> = { verified: false, state: 'UNKNOWN' };
    for (let i = 0; i < Math.max(attempts, 1); i++) {
      const current = await this.vercel.getDeployment(deploymentId);
      await this.heartbeat(repairId, leaseId);
      const events =
        current.state === 'READY'
          ? await this.vercel.getBuildEvents(deploymentId)
          : [];
      const eventText = events
        .map((event) => event.text)
        .join('\n')
        .toLowerCase();
      const signature = failureSignature?.toLowerCase() ?? '';
      const failureSignatureAbsent =
        !signature ||
        (!(current.errorMessage ?? '').toLowerCase().includes(signature) &&
          !eventText.includes(signature));
      latest = {
        verified: current.state === 'READY' && failureSignatureAbsent,
        state: current.state,
        deploymentId,
        errorCode: current.errorCode,
        errorMessage: current.errorMessage,
        failureSignatureAbsent,
      };
      if (latest.verified === true) return latest;
      if (i < attempts - 1) await this.sleep(delayMs);
    }
    return latest;
  }

  private async transition(id: string, status: JarvisRepairStatus, leaseId?: string) {
    const result = await this.prisma.jarvisEngineeringRepair.updateMany({
      where: leaseId ? { id, executionLeaseId: leaseId } : { id },
      data: { status },
    });
    if (result.count !== 1) throw new BadRequestException('Repair execution lease was lost.');
    return this.getById(id);
  }
  private async getById(id: string) {
    const repair = await this.prisma.jarvisEngineeringRepair.findUnique({ where: { id } });
    if (!repair) throw new NotFoundException('JARVIS engineering repair was not found.');
    return repair;
  }
  private async fail(
    id: string,
    error: string,
    extra?: Record<string, unknown>,
    leaseId?: string,
  ) {
    await this.prisma.jarvisEngineeringRepair.updateMany({
      where: leaseId ? { id, executionLeaseId: leaseId } : { id },
      data: {
        status: JarvisRepairStatus.FAILED,
        error,
        verification: extra ? this.toJson(extra) : undefined,
        completedAt: new Date(),
      },
    });
  }

  private requirePlan(value: unknown): RepairWorkflowPlan {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Persisted repair plan is invalid.');
    }
    const plan = value as Record<string, unknown>;
    if (
      typeof plan.repository !== 'string' ||
      typeof plan.baseCommit !== 'string' ||
      typeof plan.branchName !== 'string' ||
      typeof plan.projectId !== 'string' ||
      !Array.isArray(plan.fixes)
    ) {
      throw new BadRequestException('Persisted repair plan is incomplete.');
    }
    return plan as unknown as RepairWorkflowPlan;
  }

  private resultString(value: unknown, ...keys: string[]): string {
    if (!value || typeof value !== 'object')
      throw new BadRequestException('Provider returned no identifier.');
    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === 'string' && candidate.trim())
        return candidate.trim();
    }
    throw new BadRequestException('Provider returned no identifier.');
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(ms, 250)),
    );
  }
}
