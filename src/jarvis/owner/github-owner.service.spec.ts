import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { GitHubOwnerService } from './github-owner.service';

describe('GitHubOwnerService', () => {
  let service: GitHubOwnerService;
  const originalFetch = global.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalOwners = process.env.JARVIS_GITHUB_ALLOWED_OWNERS;

  beforeEach(() => {
    service = new GitHubOwnerService();
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.JARVIS_GITHUB_ALLOWED_OWNERS = 'Stackaura-Payments';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    if (originalOwners === undefined) delete process.env.JARVIS_GITHUB_ALLOWED_OWNERS;
    else process.env.JARVIS_GITHUB_ALLOWED_OWNERS = originalOwners;
  });

  it('returns only the bounded repository snapshot fields', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 1183538769,
        full_name: 'Stackaura-Payments/stackaura-checkout-api',
        name: 'stackaura-checkout-api',
        owner: { login: 'Stackaura-Payments', email: 'owner@example.com' },
        visibility: 'public',
        default_branch: 'main',
        archived: false,
        size: 644,
        private: false,
        permissions: { admin: true, push: true },
        clone_url: 'https://secret.example/repo.git',
      }),
    });

    await expect(
      service.getRepositoryStatus('Stackaura-Payments/stackaura-checkout-api'),
    ).resolves.toEqual({
      repository: {
        id: 1183538769,
        fullName: 'Stackaura-Payments/stackaura-checkout-api',
        name: 'stackaura-checkout-api',
        owner: 'Stackaura-Payments',
        visibility: 'public',
        defaultBranch: 'main',
        archived: false,
        sizeKb: 644,
      },
      provider: 'github',
      readOnly: true,
      mutationsEnabled: false,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/Stackaura-Payments/stackaura-checkout-api',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      }),
    );
  });

  it('rejects repositories outside the configured owner allowlist', async () => {
    await expect(service.getRepositoryStatus('other-owner/repo')).rejects.toThrow(
      BadRequestException,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails closed when the GitHub token is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(
      service.getRepositoryStatus('Stackaura-Payments/stackaura-checkout-api'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps a GitHub 404 to a bounded access error', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 });
    await expect(
      service.getRepositoryStatus('Stackaura-Payments/missing'),
    ).rejects.toThrow('not found or is not accessible');
  });
});
