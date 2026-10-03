import { PrismaService } from '../../prisma/prisma.service';
import { GitHubOwnerService } from '../owner/github-owner.service';
import { VercelOwnerService } from '../owner/vercel-owner.service';
import { EngineeringDiagnosis } from './engineering-diagnostic.types';
import { EngineeringRepairWorkflowService } from './engineering-repair-workflow.service';
import { EngineeringSourceInspectionService } from './engineering-source-inspection.service';

describe('EngineeringRepairWorkflowService diagnosis mapping', () => {
  const service = new EngineeringRepairWorkflowService(
    {} as PrismaService,
    {} as GitHubOwnerService,
    {} as VercelOwnerService,
    {} as EngineeringSourceInspectionService,
  );
  const fix = {
    path: 'src/example.ts',
    content: 'export const enabled = true;\n',
    sha: 'file-sha',
    message: 'fix: restore compiler-reported line',
    rationale: 'Restore the exact failing line from the known-good revision.',
    evidence: ['Compiler error references src/example.ts:1.'],
  };

  function diagnosis(
    arguments_: Record<string, unknown>,
  ): EngineeringDiagnosis {
    return {
      provider: 'vercel',
      target: 'preview',
      selection: {
        requested: 'latest-failed',
        selectedReason: 'Latest failed deployment',
        consideredDeployments: 1,
      },
      deployment: {
        id: 'deployment-id',
        state: 'ERROR',
        createdAt: '2026-10-03T00:00:00.000Z',
        url: 'preview.example.com',
        commitSha: 'commit-sha',
        commitMessage: null,
        branch: 'main',
        errorCode: null,
        errorMessage: 'Compiler error',
        errorStep: 'build',
      },
      evidence: [],
      sourceAnalysis: {
        repository: 'owner/repository',
        changedFiles: [fix.path],
        relevantFiles: [fix.path],
        previousKnownGoodCommit: 'good-sha',
        fileComparisons: [],
        findings: [],
      },
      diagnosis: {
        category: 'build',
        rootCause: 'Compiler error',
        confidence: 'high',
        impact: 'Build failed',
      },
      remediation: {
        summary: 'Restore the failing line',
        exactFix: fix.rationale,
        actions: [
          {
            toolId: 'jarvis.owner.github.update-file',
            intent: 'apply-source-remediation',
            arguments: arguments_,
            requiresApproval: true,
          },
        ],
      },
      limitations: [],
    };
  }

  it('preserves the exact rationale and evidence with the source fix', () => {
    const result = service['inspectionFromDiagnosis'](diagnosis(fix));
    expect(result.fixes).toEqual([fix]);
    expect(result.previousKnownGoodCommit).toBe('good-sha');
  });

  it.each([
    { ...fix, rationale: undefined },
    { ...fix, evidence: undefined },
    { ...fix, evidence: [123] },
    { ...fix, content: undefined },
  ])('rejects malformed source fixes without inventing evidence', (args) => {
    expect(service['inspectionFromDiagnosis'](diagnosis(args)).fixes).toEqual(
      [],
    );
  });

  it('does not treat deployment actions as source fixes', () => {
    const input = diagnosis(fix);
    input.remediation.actions[0].toolId = 'jarvis.owner.vercel.deploy';
    expect(service['inspectionFromDiagnosis'](input).fixes).toEqual([]);
  });
});
