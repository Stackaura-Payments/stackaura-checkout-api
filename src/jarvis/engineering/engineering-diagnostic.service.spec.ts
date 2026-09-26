import { Test } from '@nestjs/testing';
import { EngineeringDiagnosticService } from './engineering-diagnostic.service';
import { EngineeringSourceInspectionService } from './engineering-source-inspection.service';
import { VercelOwnerService } from '../owner/vercel-owner.service';
import { GitHubOwnerService } from '../owner/github-owner.service';

describe('EngineeringDiagnosticService', () => {
  const vercel = { listDeployments: jest.fn(), getDeployment: jest.fn(), getBuildEvents: jest.fn() };
  const github = { getCommitSnapshot: jest.fn() };
  const source = { inspect: jest.fn() };
  let service: EngineeringDiagnosticService;

  beforeEach(async () => {
    jest.clearAllMocks();
    source.inspect.mockResolvedValue({
      previousKnownGoodCommit: null,
      fileComparisons: [],
      findings: [],
      fixes: [],
    });
    const module = await Test.createTestingModule({
      providers: [
        EngineeringDiagnosticService,
        { provide: VercelOwnerService, useValue: vercel },
        { provide: GitHubOwnerService, useValue: github },
        { provide: EngineeringSourceInspectionService, useValue: source },
      ],
    }).compile();
    service = module.get(EngineeringDiagnosticService);
  });

  it('uses concrete Vercel build errors and correlates them to the changed source file', async () => {
    vercel.listDeployments.mockResolvedValue([
      { id: 'dpl_fail', state: 'ERROR', target: 'production', createdAt: '2026-09-22T00:00:00.000Z', branch: 'feat/voice', commitSha: 'abc123' },
      { id: 'dpl_good', state: 'READY', target: 'production', createdAt: '2026-09-21T00:00:00.000Z', branch: 'main', commitSha: 'good123' },
    ]);
    vercel.getDeployment.mockResolvedValue({
      id: 'dpl_fail', projectId: 'prj_test', url: 'failed.vercel.app', state: 'ERROR', target: 'production',
      createdAt: '2026-09-22T00:00:00.000Z', commitSha: 'abc123', commitMessage: 'voice build failure', branch: 'feat/voice',
      errorCode: 'BUILD_UTILS_SPAWN_1', errorMessage: 'Command "npm run build" exited with 1', errorStep: 'buildStep',
    });
    vercel.getBuildEvents.mockResolvedValue([
      { type: 'stderr', text: 'Type error: app/jarvis/components/voice-agent.tsx(214,17): Property "foo" does not exist on type "Bar".', createdAt: '2026-09-22T00:00:02.000Z' },
      { type: 'exit', text: 'Command "npm run build" exited with 1', createdAt: '2026-09-22T00:00:03.000Z' },
    ]);
    github.getCommitSnapshot.mockResolvedValue({
      sha: 'abc123', parentSha: 'good123', message: 'voice build failure', author: 'Stackaura',
      changedFiles: ['app/jarvis/components/voice-agent.tsx'],
    });
    source.inspect.mockResolvedValue({
      previousKnownGoodCommit: 'good123',
      failureDomain: 'build',
      rootCause: 'The Vercel build log references changed source file(s): app/jarvis/components/voice-agent.tsx.',
      confidence: 'high',
      exactFix: null,
      fileComparisons: [{
        path: 'app/jarvis/components/voice-agent.tsx',
        currentSha: 'current',
        previousSha: 'old',
        changed: true,
        changeSummary: 'File content differs.',
      }],
      findings: ['Build-log/source correlation: Vercel explicitly referenced changed file(s) app/jarvis/components/voice-agent.tsx.'],
      fixes: [],
    });

    const result = await service.diagnoseVercelDeployment('latest-failed');

    expect(result.diagnosis.rootCause).toContain('Type error');
    expect(result.diagnosis.category).toBe('buildStep');
    expect(result.sourceAnalysis.relevantFiles).toContain('app/jarvis/components/voice-agent.tsx');
    expect(result.evidence.some((item) => item.source === 'vercel.build-log' && item.fact.includes('Type error'))).toBe(true);
  });

  it('selects the latest failed deployment instead of a newer healthy deployment', async () => {
    vercel.listDeployments.mockResolvedValue([
      { id: 'dpl_ready', state: 'READY', target: 'production', createdAt: '2026-09-21T00:00:00.000Z', branch: 'main', commitSha: 'good123' },
      { id: 'dpl_fail', state: 'ERROR', target: 'production', createdAt: '2026-09-22T00:00:00.000Z', branch: 'main', commitSha: 'abc123' },
    ]);
    vercel.getDeployment.mockResolvedValue({
      id: 'dpl_fail', projectId: 'prj_test', url: 'failed.vercel.app', state: 'ERROR', target: 'production',
      createdAt: '2026-09-22T00:00:00.000Z', commitSha: 'abc123', commitMessage: 'bad deploy', branch: 'main',
      errorCode: 'unsupported_platform', errorMessage: 'Command "npm install" exited with 1', errorStep: 'buildStep',
    });
    vercel.getBuildEvents.mockResolvedValue([{ type: 'error', text: 'Command "npm install" exited with 1', createdAt: '2026-09-22T00:00:02.000Z' }]);
    github.getCommitSnapshot.mockResolvedValue({ sha: 'abc123', message: 'bad deploy', author: 'Stackaura', changedFiles: ['package.json', 'app/page.tsx'] });

    const result = await service.diagnoseVercelDeployment('latest-failed');

    expect(result.deployment.id).toBe('dpl_fail');
    expect(result.selection.requested).toBe('latest-failed');
    expect(result.selection.consideredDeployments).toBe(2);
    expect(result.sourceAnalysis.relevantFiles).toContain('package.json');
    expect(source.inspect).toHaveBeenCalledWith('Stackaura-Payments/stackaura', 'abc123', expect.any(Array), 'good123', 'dependency-installation');
    expect(result.evidence.find((item) => item.source === 'vercel.previous-known-good')?.data).toMatchObject({ id: 'dpl_ready', commitSha: 'good123' });
    expect(result.diagnosis.category).toBe('dependency-installation');
    expect(result.remediation.actions[0]).toMatchObject({ toolId: 'jarvis.owner.vercel.deploy', requiresApproval: true });
  });

  it('falls back to the latest deployment when no failed deployment exists', async () => {
    vercel.listDeployments.mockResolvedValue([{ id: 'dpl_ready', state: 'READY', target: 'production', createdAt: '2026-09-23T00:00:00.000Z' }]);
    vercel.getDeployment.mockResolvedValue({
      id: 'dpl_ready', projectId: 'prj_test', url: 'ready.vercel.app', state: 'READY', target: 'production',
      createdAt: '2026-09-23T00:00:00.000Z', commitSha: null, commitMessage: null, branch: 'main',
      errorCode: null, errorMessage: null, errorStep: null,
    });
    vercel.getBuildEvents.mockResolvedValue([]);

    const result = await service.diagnoseVercelDeployment('latest-failed');
    expect(result.deployment.id).toBe('dpl_ready');
    expect(result.diagnosis.category).toBe('none-detected');
    expect(result.remediation.actions).toEqual([]);
  });
});
