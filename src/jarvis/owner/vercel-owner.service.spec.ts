import { ServiceUnavailableException } from '@nestjs/common';
import { VercelOwnerService } from './vercel-owner.service';

describe('VercelOwnerService', () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.VERCEL_TOKEN;
  const originalProjectId = process.env.VERCEL_PROJECT_ID;
  const originalTeamId = process.env.VERCEL_TEAM_ID;
  let service: VercelOwnerService;

  beforeEach(() => {
    service = new VercelOwnerService();
    process.env.VERCEL_TOKEN = 'test-token';
    process.env.VERCEL_PROJECT_ID = 'prj_test';
    process.env.VERCEL_TEAM_ID = 'team_test';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = originalToken;
    if (originalProjectId === undefined) delete process.env.VERCEL_PROJECT_ID;
    else process.env.VERCEL_PROJECT_ID = originalProjectId;
    if (originalTeamId === undefined) delete process.env.VERCEL_TEAM_ID;
    else process.env.VERCEL_TEAM_ID = originalTeamId;
  });
  it('returns a bounded read-only latest deployment snapshot', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        deployments: [
          {
            uid: 'dpl_123',
            projectId: 'prj_test',
            url: 'stackaura-example.vercel.app',
            state: 'READY',
            target: 'production',
            created: 1780060800000,
            meta: {
              githubCommitSha: 'abc123',
              githubCommitMessage: 'Deploy JARVIS',
              githubCommitRef: 'main',
            },
          },
        ],
      }),
    });

    await expect(service.getLatestDeployment()).resolves.toEqual({
      deployment: {
        id: 'dpl_123',
        projectId: 'prj_test',
        url: 'stackaura-example.vercel.app',
        state: 'READY',
        target: 'production',
        createdAt: new Date(1780060800000).toISOString(),
        commitSha: 'abc123',
        commitMessage: 'Deploy JARVIS',
        branch: 'main',
      },
      provider: 'vercel',
      readOnly: true,
      mutationsEnabled: false,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v13/deployments?'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('projectId=prj_test');
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('limit=1');
  });
  it('fails closed when the integration is not configured', async () => {
    delete process.env.VERCEL_TOKEN;

    await expect(service.getLatestDeployment()).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails closed when Vercel returns an unsuccessful response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false });

    await expect(service.getLatestDeployment()).rejects.toThrow(
      'Vercel deployment status could not be retrieved.',
    );
  });

  it('does not expose mutation controls in the result', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        deployments: [{
          uid: 'dpl_123',
          url: 'example.vercel.app',
          state: 'READY',
          created: 1780060800000,
        }],
      }),
    });

    const result = await service.getLatestDeployment();
    expect(result.readOnly).toBe(true);
    expect(result.mutationsEnabled).toBe(false);
  });
});
