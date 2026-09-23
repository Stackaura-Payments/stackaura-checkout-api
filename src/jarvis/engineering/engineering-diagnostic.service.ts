import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { GitHubOwnerService } from '../owner/github-owner.service';
import { VercelOwnerService } from '../owner/vercel-owner.service';
import { EngineeringDiagnosis, EngineeringEvidence } from './engineering-diagnostic.types';

@Injectable()
export class EngineeringDiagnosticService {
  constructor(
    private readonly vercelOwnerService: VercelOwnerService,
    private readonly githubOwnerService: GitHubOwnerService,
  ) {}

  async diagnoseLatestVercelDeployment(): Promise<EngineeringDiagnosis> {
    const deployments = await this.vercelOwnerService.listDeployments(10);
    if (!deployments.length) {
      throw new ServiceUnavailableException('Vercel returned no deployments for the configured project.');
    }

    const deployment = deployments[0];
    const details = await this.vercelOwnerService.getDeployment(deployment.id);
    const events = await this.vercelOwnerService.getBuildEvents(deployment.id);
    const evidence: EngineeringEvidence[] = [];

    evidence.push({
      source: 'vercel.deployment',
      fact: `Deployment ${details.id} is ${details.state}.`,
      confidence: 'high',
      data: { id: details.id, state: details.state, target: details.target },
    });

    if (details.errorCode || details.errorMessage || details.errorStep) {
      evidence.push({
        source: 'vercel.deployment.error',
        fact: [details.errorCode, details.errorStep, details.errorMessage].filter(Boolean).join(' — '),
        confidence: 'high',
        data: { errorCode: details.errorCode, errorStep: details.errorStep, errorMessage: details.errorMessage },
      });
    }

    if (details.commitSha) {
      evidence.push({
        source: 'vercel.git',
        fact: `Deployment was built from commit ${details.commitSha}.`,
        confidence: 'high',
        data: { commitSha: details.commitSha, branch: details.branch, commitMessage: details.commitMessage },
      });
    }

    if (events.length) {
      const relevant = events.filter((event) => event.type === 'error' || /error|failed|fail|npm install|build/i.test(event.text));
      for (const event of relevant.slice(-8)) {
        evidence.push({ source: 'vercel.build-log', fact: event.text, confidence: 'high', data: { type: event.type, createdAt: event.createdAt } });
      }
    }

    if (details.commitSha) {
      try {
        const commit = await this.githubOwnerService.getCommitSnapshot(
          this.repositoryForDeployment(details),
          details.commitSha,
        );
        evidence.push({
          source: 'github.commit',
          fact: `GitHub confirms commit ${commit.sha} with message: ${commit.message}.`,
          confidence: 'high',
          data: { sha: commit.sha, message: commit.message, author: commit.author, changedFiles: commit.changedFiles },
        });
      } catch (error) {
        evidence.push({
          source: 'github.commit',
          fact: error instanceof Error ? error.message : 'GitHub commit correlation failed.',
          confidence: 'low',
        });
      }
    }

    const diagnosis = this.buildDiagnosis(details, events);
    return {
      provider: 'vercel',
      target: details.target === 'production' ? 'production' : details.target === 'preview' ? 'preview' : 'unknown',
      deployment: details,
      evidence,
      diagnosis,
      remediation: this.buildRemediation(details, diagnosis.category),
      limitations: events.length ? [] : ['Vercel build events were unavailable; diagnosis uses deployment metadata only.'],
    };
  }
  private buildDiagnosis(
    deployment: Awaited<ReturnType<VercelOwnerService['getDeployment']>>,
    events: Array<{ type: string; text: string; createdAt: string }>,
  ): EngineeringDiagnosis['diagnosis'] {
    const logText = events.map((event) => event.text).join('\n');
    if (deployment.errorCode === 'unsupported_platform' || /npm install.*exited with 1/i.test(logText)) {
      return {
        category: 'dependency-installation',
        rootCause: deployment.errorMessage || 'The Vercel dependency installation step exited with code 1.',
        confidence: deployment.errorCode ? 'high' : 'medium',
        impact: 'The production deployment could not complete the build, so the failed revision was not promoted as a healthy deployment.',
      };
    }
    if (deployment.errorMessage) {
      return {
        category: deployment.errorStep || 'deployment-build',
        rootCause: deployment.errorMessage,
        confidence: 'high',
        impact: 'The Vercel deployment entered an error state and did not complete successfully.',
      };
    }
    if (deployment.state === 'READY') {
      return {
        category: 'none-detected',
        rootCause: 'The latest deployment is READY; no deployment failure is present in the selected revision.',
        confidence: 'high',
        impact: 'No current production deployment failure is indicated by Vercel metadata.',
      };
    }
    return {
      category: 'deployment-state',
      rootCause: `Vercel reports the latest deployment state as ${deployment.state}.`,
      confidence: 'medium',
      impact: 'The deployment is not currently in a healthy READY state.',
    };
  }

  private buildRemediation(
    deployment: Awaited<ReturnType<VercelOwnerService['getDeployment']>>,
    category: string,
  ): EngineeringDiagnosis['remediation'] {
    if (deployment.state === 'READY' || category === 'none-detected') {
      return { summary: 'No mutation is recommended from this diagnosis.', actions: [] };
    }
    return {
      summary: 'Inspect the failing revision, correct the build/dependency issue, then redeploy the verified source. Any deployment mutation requires owner approval.',
      actions: [
        {
          toolId: 'jarvis.owner.vercel.deploy',
          intent: 'redeploy-production-after-remediation',
          arguments: { target: 'production', ref: deployment.branch || 'main' },
          requiresApproval: true,
        },
      ],
    };
  }

  private repositoryForDeployment(deployment: Awaited<ReturnType<VercelOwnerService['getDeployment']>>): string {
    const configured = process.env.JARVIS_VERCEL_GITHUB_REPOSITORY?.trim();
    if (configured) return configured;
    return 'Stackaura-Payments/stackaura';
  }
}
