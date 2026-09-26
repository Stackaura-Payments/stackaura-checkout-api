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
  it('verifies an updated file against the approved content', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ content: Buffer.from('new content', 'utf8').toString('base64'), sha: 'new-blob-sha' }),
    });

    await expect(service.verifyMutation('jarvis.owner.github.update-file', {
      repositoryFullName: 'Stackaura-Payments/stackaura-checkout-api',
      path: 'README.md',
      content: 'new content',
      branch: 'main',
    })).resolves.toMatchObject({ verified: true, mode: 'github-file-content', observedSha: 'new-blob-sha' });
  });

  it('verifies a created branch points at the approved commit', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ object: { sha: 'base-sha' } }),
    });

    await expect(service.verifyMutation('jarvis.owner.github.create-branch', {
      repositoryFullName: 'Stackaura-Payments/stackaura-checkout-api',
      branchName: 'jarvis/recovery',
      sha: 'base-sha',
    })).resolves.toMatchObject({ verified: true, mode: 'github-branch-ref' });
  });

  it('verifies a pull request is merged and matches the returned merge SHA', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ merged: true, merge_commit_sha: 'merge-sha' }),
    });

    await expect(service.verifyMutation('jarvis.owner.github.merge-pull-request', {
      repositoryFullName: 'Stackaura-Payments/stackaura-checkout-api',
      prNumber: 42,
    }, { sha: 'merge-sha' })).resolves.toMatchObject({ verified: true, mode: 'github-pr-merge' });
  });

  it('verifies a workflow rerun is queued, running, or successful', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ status: 'in_progress', conclusion: null }),
    });

    await expect(service.verifyMutation('jarvis.owner.github.rerun-workflow', {
      repositoryFullName: 'Stackaura-Payments/stackaura-checkout-api',
      jobId: 123,
    })).resolves.toMatchObject({ verified: true, mode: 'github-workflow-job', status: 'in_progress' });
  });


  it('refuses to delete the repository default branch', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, full_name: 'Stackaura-Payments/repo', name: 'repo', owner: { login: 'Stackaura-Payments' }, visibility: 'private', default_branch: 'main', archived: false, size: 1 }),
    });

    await expect(service.deleteBranch({
      repositoryFullName: 'Stackaura-Payments/repo',
      branchName: 'main',
    })).rejects.toThrow('default branch');
  });

  it('produces an approval-gated branch deletion recovery plan', () => {
    expect(service.getRecoveryPlan('jarvis.owner.github.create-branch', {
      repositoryFullName: 'Stackaura-Payments/repo',
      branchName: 'jarvis/recovery',
    })).toEqual(expect.objectContaining({
      executable: true,
      toolId: 'jarvis.owner.github.delete-branch',
      approvalRequired: true,
    }));
  });

});
