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

  it('selects the latest failed deployment instead of a newer healthy deployment', async () => {
    vercel.listDeployments.mockResolvedValue([
      { id: 'dpl_ready', state: 'READY', target: 'production', createdAt: '2026-09-23T00:00:00.000Z' },
      { id: 'dpl_fail', state: 'ERROR', target: 'production', createdAt: '2026-09-22T00:00:00.000Z' },
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
