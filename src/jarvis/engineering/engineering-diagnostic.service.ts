import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { GitHubOwnerService } from '../owner/github-owner.service';
import { VercelOwnerService } from '../owner/vercel-owner.service';
import { EngineeringDiagnosis, EngineeringEvidence } from './engineering-diagnostic.types';
import { EngineeringSourceInspectionService } from './engineering-source-inspection.service';

@Injectable()
export class EngineeringDiagnosticService {
  constructor(
    private readonly vercelOwnerService: VercelOwnerService,
    private readonly githubOwnerService: GitHubOwnerService,
    private readonly sourceInspectionService: EngineeringSourceInspectionService,
  ) {}

  async diagnoseVercelDeployment(mode: 'latest' | 'latest-failed' = 'latest-failed'): Promise<EngineeringDiagnosis> {
    const deployments = await this.vercelOwnerService.listDeployments(25);
    if (!deployments.length) throw new ServiceUnavailableException('Vercel returned no deployments for the configured project.');

    const selected = mode === 'latest'
      ? deployments[0]
      : deployments.find((deployment) => deployment.state === 'ERROR' || deployment.state === 'CANCELED');

    if (!selected) {
      const latest = deployments[0];
      return this.diagnoseSelectedDeployment(latest, deployments, mode, 'No failed deployment was found in the inspected timeline; the latest deployment was selected.');
    }

    return this.diagnoseSelectedDeployment(
      selected,
      deployments,
      mode,
      mode === 'latest-failed' ? 'Selected the most recent failed deployment in the inspected Vercel timeline.' : 'Selected the latest deployment.',
    );
  }

  async diagnoseLatestVercelDeployment(): Promise<EngineeringDiagnosis> {
    return this.diagnoseVercelDeployment('latest-failed');
  }

  private async diagnoseSelectedDeployment(
    selected: { id: string; state: string; target: string | null; createdAt: string },
    deployments: Array<{ id: string; state: string; target: string | null; createdAt: string }>,
    mode: 'latest' | 'latest-failed',
    selectedReason: string,
  ): Promise<EngineeringDiagnosis> {
    const details = await this.vercelOwnerService.getDeployment(selected.id);
    const events = await this.vercelOwnerService.getBuildEvents(selected.id);
    const evidence: EngineeringEvidence[] = [
      {
        source: 'vercel.timeline',
        fact: `Inspected ${deployments.length} recent deployments and selected ${details.id}.`,
        confidence: 'high',
        data: { requested: mode, selectedReason, consideredDeployments: deployments.length },
      },
      {
        source: 'vercel.deployment',
        fact: `Deployment ${details.id} is ${details.state}.`,
        confidence: 'high',
        data: { id: details.id, state: details.state, target: details.target, createdAt: details.createdAt },
      },
    ];

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

    const relevantEvents = events.filter((event) => /error|failed|fail|npm install|build/i.test(event.text));
    for (const event of relevantEvents.slice(-12)) {
      evidence.push({ source: 'vercel.build-log', fact: event.text, confidence: 'high', data: { type: event.type, createdAt: event.createdAt } });
    }

    let repository: string | null = null;
    let changedFiles: string[] = [];
    let relevantFiles: string[] = [];
    const findings: string[] = [];

    if (details.commitSha) {
      repository = this.repositoryForDeployment();
      try {
        const commit = await this.githubOwnerService.getCommitSnapshot(repository, details.commitSha);
        changedFiles = commit.changedFiles;
        relevantFiles = this.selectRelevantFiles(changedFiles, details.errorMessage ?? '', relevantEvents.map((event) => event.text));
        evidence.push({
          source: 'github.commit',
          fact: `GitHub confirms commit ${commit.sha} with message: ${commit.message}.`,
          confidence: 'high',
          data: { sha: commit.sha, message: commit.message, author: commit.author, changedFiles },
        });
        if (relevantFiles.length) findings.push(`The failing revision changed relevant build/dependency files: ${relevantFiles.join(', ')}.`);
        if (changedFiles.includes('package.json')) findings.push('The failing revision changed package.json, so dependency installation is a source-level suspect.');
        if (changedFiles.includes('package-lock.json') || changedFiles.includes('npm-shrinkwrap.json')) findings.push('The failing revision changed an npm lockfile, so dependency resolution may have changed.');
        if (changedFiles.includes('pnpm-lock.yaml') || changedFiles.includes('yarn.lock')) findings.push('The failing revision changed a package-manager lockfile.');
      } catch (error) {
        evidence.push({ source: 'github.commit', fact: error instanceof Error ? error.message : 'GitHub commit correlation failed.', confidence: 'low' });
      }
    }

    const sourceInspection = repository && details.commitSha
      ? await this.sourceInspectionService.inspect(repository, details.commitSha, relevantFiles)
      : { previousKnownGoodCommit: null, fileComparisons: [], findings: [], fixes: [] };

    findings.push(...sourceInspection.findings);

    const diagnosis = this.buildDiagnosis(details, events, changedFiles, relevantFiles);
    const sourceFinding = sourceInspection.findings.find((finding) => /High-confidence source finding/i.test(finding));
    if (sourceFinding) {
      diagnosis.rootCause = sourceFinding;
      diagnosis.confidence = 'high';
    }
    const remediation = this.buildRemediation(details, diagnosis.category, sourceInspection);
    return {
      provider: 'vercel',
      target: details.target === 'production' ? 'production' : details.target === 'preview' ? 'preview' : 'unknown',
      selection: { requested: mode, selectedReason, consideredDeployments: deployments.length },
      deployment: details,
      evidence,
      sourceAnalysis: {
        repository,
        changedFiles,
        relevantFiles,
        previousKnownGoodCommit: sourceInspection.previousKnownGoodCommit,
        fileComparisons: sourceInspection.fileComparisons,
        findings,
      },
      diagnosis,
      remediation,
      limitations: events.length ? [] : ['Vercel build events were unavailable; diagnosis uses deployment metadata and source correlation only.'],
    };
  }

  private buildDiagnosis(
    deployment: Awaited<ReturnType<VercelOwnerService['getDeployment']>>,
    events: Array<{ type: string; text: string; createdAt: string }>,
    changedFiles: string[],
    relevantFiles: string[],
  ): EngineeringDiagnosis['diagnosis'] {
    const logText = events.map((event) => event.text).join('\n');
    if (deployment.errorCode === 'unsupported_platform' || /npm install.*exited with 1/i.test(logText)) {
      const sourceQualifier = relevantFiles.length ? ` Changed files support inspecting ${relevantFiles.join(', ')}.` : '';
      return {
        category: 'dependency-installation',
        rootCause: deployment.errorMessage || 'The Vercel dependency installation step exited with code 1.',
        confidence: deployment.errorCode && changedFiles.length ? 'high' : 'medium',
        impact: 'The production build could not complete, so the failing revision was not promoted as a healthy deployment.' + sourceQualifier,
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
        rootCause: 'The selected deployment is READY; no deployment failure is present in the selected revision.',
        confidence: 'high',
        impact: 'No failure is indicated by the selected Vercel deployment metadata.',
      };
    }
    return {
      category: 'deployment-state',
      rootCause: `Vercel reports the selected deployment state as ${deployment.state}.`,
      confidence: 'medium',
      impact: 'The selected deployment is not currently in a healthy READY state.',
    };
  }

  private buildRemediation(
    deployment: Awaited<ReturnType<VercelOwnerService['getDeployment']>>,
    category: string,
    sourceInspection: Awaited<ReturnType<EngineeringSourceInspectionService['inspect']>>,
  ): EngineeringDiagnosis['remediation'] {
    if (deployment.state === 'READY' || category === 'none-detected') {
      return { summary: 'No mutation is recommended from this diagnosis.', exactFix: 'No source change is indicated.', actions: [] };
    }

    if (sourceInspection.fixes.length) {
      return {
        summary: 'Apply the exact source remediation, then redeploy the verified revision.',
        exactFix: sourceInspection.fixes.map((fix) => fix.path + ': ' + fix.message).join(' '),
        actions: [
          ...sourceInspection.fixes.map((fix) => ({
            toolId: 'jarvis.owner.github.update-file',
            intent: 'apply-source-remediation-' + fix.path,
            arguments: {
              repositoryFullName: this.repositoryForDeployment(),
              path: fix.path,
              content: fix.content,
              message: fix.message,
              sha: fix.sha,
              branch: deployment.branch || 'main',
            },
            requiresApproval: true as const,
          })),
          {
            toolId: 'jarvis.owner.vercel.deploy',
            intent: 'redeploy-production-after-remediation',
            arguments: { target: 'production', ref: deployment.branch || 'main' },
            requiresApproval: true as const,
          },
        ],
      };
    }

    return {
      summary: 'Correct the identified source/build issue, then redeploy. Deployment mutation requires owner approval.',
      exactFix: sourceInspection.findings.join(' ') || 'No exact source edit could be safely generated.',
      actions: [{
        toolId: 'jarvis.owner.vercel.deploy',
        intent: 'redeploy-production-after-remediation',
        arguments: { target: 'production', ref: deployment.branch || 'main' },
        requiresApproval: true,
      }],
    };
  }
  private selectRelevantFiles(changedFiles: string[], errorMessage: string, eventText: string[]): string[] {
    const haystack = (errorMessage + '\n' + eventText.join('\n')).toLowerCase();
    return changedFiles.filter((file) => {
      const lower = file.toLowerCase();
      return /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(lower)
        || haystack.includes(lower);
    }).slice(0, 20);
  }

  private repositoryForDeployment(): string {
    return process.env.JARVIS_VERCEL_GITHUB_REPOSITORY?.trim() || 'Stackaura-Payments/stackaura';
  }
}
