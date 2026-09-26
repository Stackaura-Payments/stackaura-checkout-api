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
  it('extracts actual Vercel build failure events from the deployment events endpoint', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify([
        { type: 'stdout', created: 1790044001000, payload: { text: '▲ Next.js 16.1.6' } },
        { type: 'stderr', created: 1790044002000, payload: { text: 'Type error: app/jarvis/components/voice-agent.tsx(214,17): Property \'foo\' does not exist on type \'Bar\'.' } },
        { type: 'exit', created: 1790044003000, payload: { text: 'Command "npm run build" exited with 1' } },
      ]),
    });

    await expect(service.getBuildEvents('dpl_failed')).resolves.toEqual([
      { type: 'stdout', text: '▲ Next.js 16.1.6', createdAt: new Date(1790044001000).toISOString() },
      { type: 'stderr', text: "Type error: app/jarvis/components/voice-agent.tsx(214,17): Property 'foo' does not exist on type 'Bar'.", createdAt: new Date(1790044002000).toISOString() },
      { type: 'exit', text: 'Command "npm run build" exited with 1', createdAt: new Date(1790044003000).toISOString() },
    ]);

    const url = String((global.fetch as jest.Mock).mock.calls[0][0]);
    expect(url).toContain('/v3/deployments/dpl_failed/events?');
    expect(url).toContain('builds=1');
    expect(url).toContain('limit=5000');
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
      expect.stringContaining('/v6/deployments?'),
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
  it('accepts the createdAt timestamp returned by the deployment details API', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        uid: 'dpl_details',
        projectId: 'prj_test',
        url: 'stackaura-details.vercel.app',
        readyState: 'ERROR',
        target: 'production',
        createdAt: 1790044000981,
        meta: { githubCommitSha: 'b44f3c8', githubCommitRef: 'main', githubCommitMessage: 'test failure' },
        errorCode: 'unsupported_platform',
        errorMessage: 'Command \"npm install\" exited with 1',
        errorStep: 'buildStep',
      }),
    });

    await expect(service.getDeployment('dpl_details')).resolves.toMatchObject({
      id: 'dpl_details',
      createdAt: new Date(1790044000981).toISOString(),
      state: 'ERROR',
      errorCode: 'unsupported_platform',
    });
  });

  it('fails closed when the integration is not configured', async () => {
    delete process.env.VERCEL_TOKEN;

    await expect(service.getLatestDeployment()).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails closed when Vercel returns an unsuccessful response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 400 });

    await expect(service.getLatestDeployment()).rejects.toThrow(
      'Vercel deployment status could not be retrieved (HTTP 400).',
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
