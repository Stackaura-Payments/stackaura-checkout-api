import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

const GITHUB_API_BASE = 'https://api.github.com';
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface GitHubRepositorySnapshot {
  repository: {
    id: number;
    fullName: string;
    name: string;
    owner: string;
    visibility: string;
    defaultBranch: string;
    archived: boolean;
    sizeKb: number;
  };
  provider: 'github';
  readOnly: true;
  mutationsEnabled: false;
}

@Injectable()
export class GitHubOwnerService {
  async getRepositoryStatus(
    repositoryFullName: string,
  ): Promise<GitHubRepositorySnapshot> {
    const fullName = repositoryFullName.trim();
    if (!REPOSITORY_PATTERN.test(fullName)) {
      throw new BadRequestException(
        'GitHub repository must use the owner/name format.',
      );
    }

    const [owner] = fullName.split('/');
    const allowedOwners = this.getAllowedOwners();
    if (!allowedOwners.includes(owner.toLowerCase())) {
      throw new BadRequestException(
        'GitHub repository owner is not authorized for JARVIS.',
      );
    }

    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new ServiceUnavailableException(
        'GitHub owner integration is not configured.',
      );
    }

    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(fullName.split('/')[1])}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!response.ok) {
      if (response.status === 404) {
        throw new BadRequestException(
          'GitHub repository was not found or is not accessible.',
        );
      }
      throw new ServiceUnavailableException(
        'GitHub repository status could not be retrieved.',
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    return {
      repository: {
        id: this.numberField(data.id, 'id'),
        fullName: this.stringField(data.full_name, 'full_name'),
        name: this.stringField(data.name, 'name'),
        owner: this.objectStringField(data.owner, 'login'),
        visibility: this.stringField(data.visibility, 'visibility'),
        defaultBranch: this.stringField(data.default_branch, 'default_branch'),
        archived: this.booleanField(data.archived, 'archived'),
        sizeKb: this.numberField(data.size, 'size'),
      },
      provider: 'github',
      readOnly: true,
      mutationsEnabled: false,
    };
  }

  async getCommitSnapshot(
    repositoryFullName: string,
    sha: string,
  ): Promise<{
    sha: string;
    parentSha: string | null;
    message: string;
    author: string | null;
    changedFiles: string[];
    patches: Array<{ path: string; status: string; patch: string | null }>;
  }> {
    this.assertRepository(repositoryFullName);
    const token = this.requireToken();
    const response = (await this.githubRequest(
      '/repos/' +
        this.repoPath(repositoryFullName) +
        '/commits/' +
        encodeURIComponent(sha),
      token,
      { method: 'GET' },
    )) as Record<string, unknown>;
    const commit =
      response.commit && typeof response.commit === 'object'
        ? (response.commit as Record<string, unknown>)
        : {};
    const author =
      commit.author && typeof commit.author === 'object'
        ? (commit.author as Record<string, unknown>)
        : {};
    const files = Array.isArray(response.files) ? response.files : [];
    const parent = Array.isArray(response.parents) && response.parents[0] && typeof response.parents[0] === 'object'
      ? response.parents[0] as Record<string, unknown>
      : {};
    return {
      sha: this.requiredString(response.sha, 'commit.sha'),
      parentSha: typeof parent.sha === 'string' ? parent.sha : null,
      message: this.requiredString(commit.message, 'commit.message'),
      author: typeof author.name === 'string' ? author.name : null,
      changedFiles: files
        .filter((file): file is Record<string, unknown> => !!file && typeof file === 'object')
        .map((file) => (typeof file.filename === 'string' ? file.filename : ''))
        .filter(Boolean)
        .slice(0, 100),
      patches: files
        .filter((file): file is Record<string, unknown> => !!file && typeof file === 'object')
        .map((file) => ({
          path: typeof file.filename === 'string' ? file.filename : '',
          status: typeof file.status === 'string' ? file.status : 'unknown',
          patch: typeof file.patch === 'string' ? file.patch.slice(0, 12000) : null,
        }))
        .filter((file) => !!file.path)
        .slice(0, 50),
    };
  }

  async getFile(
    repositoryFullName: string,
    path: string,
    ref?: string,
  ): Promise<{ content: string; sha: string }> {
    this.assertRepository(repositoryFullName);
    const token = this.requireToken();
    const query = ref ? '?ref=' + encodeURIComponent(ref) : '';
    const data = (await this.githubRequest(
      '/repos/' +
        this.repoPath(repositoryFullName) +
        '/contents/' +
        this.encodePath(path) +
        query,
      token,
      { method: 'GET' },
    )) as Record<string, unknown>;
    const encoded =
      typeof data.content === 'string' ? data.content.replace(/\\s/g, '') : '';
    return {
      content: Buffer.from(encoded, 'base64').toString('utf8'),
      sha: this.requiredString(data.sha, 'content.sha'),
    };
  }

  async getBranch(
    repositoryFullName: string,
    branchName: string,
  ): Promise<string> {
    this.assertRepository(repositoryFullName);
    const token = this.requireToken();
    const data = (await this.githubRequest(
      '/repos/' +
        this.repoPath(repositoryFullName) +
        '/git/ref/heads/' +
        encodeURIComponent(branchName),
      token,
      { method: 'GET' },
    )) as Record<string, unknown>;
    const object =
      data.object && typeof data.object === 'object'
        ? (data.object as Record<string, unknown>)
        : {};
    return this.requiredString(object.sha, 'branch.sha');
  }

  async getBranchSnapshot(repositoryFullName: string, branchName: string): Promise<Record<string, unknown>> {
    this.assertRepository(repositoryFullName);
    const token = this.requireToken();
    const data = (await this.githubRequest(
      '/repos/' + this.repoPath(repositoryFullName) + '/branches/' + encodeURIComponent(branchName),
      token,
      { method: 'GET' },
    )) as Record<string, unknown>;
    const commit = data.commit && typeof data.commit === 'object'
      ? (data.commit as Record<string, unknown>)
      : {};
    return {
      name: typeof data.name === 'string' ? data.name : branchName,
      protected: data.protected === true,
      sha: typeof commit.sha === 'string' ? commit.sha : null,
      commitUrl: typeof commit.html_url === 'string' ? commit.html_url : null,
    };
  }

  async getPullRequest(repositoryFullName: string, prNumber: number): Promise<Record<string, unknown>> {
    this.assertRepository(repositoryFullName);
    const token = this.requireToken();
    return (await this.githubRequest(
      '/repos/' + this.repoPath(repositoryFullName) + '/pulls/' + this.requiredInteger(prNumber, 'prNumber'),
      token,
      { method: 'GET' },
    )) as Record<string, unknown>;
  }

  async getWorkflowRun(repositoryFullName: string, runId: number): Promise<Record<string, unknown>> {
    this.assertRepository(repositoryFullName);
    const token = this.requireToken();
    return (await this.githubRequest(
      '/repos/' + this.repoPath(repositoryFullName) + '/actions/runs/' + this.requiredInteger(runId, 'runId'),
      token,
      { method: 'GET' },
    )) as Record<string, unknown>;
  }

  async dispatchWorkflow(input: {
    repositoryFullName: string;
    workflowFile: string;
    ref: string;
    inputs?: Record<string, string>;
  }): Promise<{ dispatched: true }> {
    this.assertRepository(input.repositoryFullName);
    const token = this.requireToken();
    await this.githubRequest(
      '/repos/' + this.repoPath(input.repositoryFullName) + '/actions/workflows/' + encodeURIComponent(input.workflowFile) + '/dispatches',
      token,
      {
        method: 'POST',
        body: JSON.stringify({ ref: this.requiredString(input.ref, 'ref'), inputs: input.inputs ?? {} }),
      },
    );
    return { dispatched: true };
  }

  async createPullRequest(input: {
    repositoryFullName: string;
    title: string;
    body?: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<unknown> {
    this.assertRepository(input.repositoryFullName);
    const token = this.requireToken();
    return this.githubRequest(
      '/repos/' + this.repoPath(input.repositoryFullName) + '/pulls',
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          title: this.requiredString(input.title, 'title'),
          body: input.body ?? '',
          head: this.requiredString(input.head, 'head'),
          base: this.requiredString(input.base, 'base'),
          draft: input.draft ?? false,
        }),
      },
    );
  }

  async closePullRequest(input: {
    repositoryFullName: string;
    prNumber: number;
  }): Promise<unknown> {
    this.assertRepository(input.repositoryFullName);
    const token = this.requireToken();
    return this.githubRequest(
      '/repos/' + this.repoPath(input.repositoryFullName) + '/pulls/' + this.requiredInteger(input.prNumber, 'prNumber'),
      token,
      { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) },
    );
  }

  async getCompareSnapshot(repositoryFullName: string, base: string, head: string): Promise<Record<string, unknown>> {
    this.assertRepository(repositoryFullName);
    const token = this.requireToken();
    const data = (await this.githubRequest(
      '/repos/' + this.repoPath(repositoryFullName) + '/compare/' + encodeURIComponent(base) + '...' + encodeURIComponent(head),
      token,
      { method: 'GET' },
    )) as Record<string, unknown>;
    const commits = Array.isArray(data.commits) ? data.commits : [];
    const files = Array.isArray(data.files) ? data.files : [];
    return {
      status: typeof data.status === 'string' ? data.status : null,
      aheadBy: typeof data.ahead_by === 'number' ? data.ahead_by : null,
      behindBy: typeof data.behind_by === 'number' ? data.behind_by : null,
      totalCommits: commits.length,
      files: files.map((file) => {
        const row = file as Record<string, unknown>;
        return {
          filename: row.filename ?? null,
          status: row.status ?? null,
          additions: row.additions ?? 0,
          deletions: row.deletions ?? 0,
          changes: row.changes ?? 0,
        };
      }).slice(0, 100),
    };
  }

  async updateFile(input: {
    repositoryFullName: string;
    path: string;
    content: string;
    message: string;
    sha: string;
    branch?: string;
  }): Promise<unknown> {
    this.assertRepository(input.repositoryFullName);
    const token = this.requireToken();
    const encodedPath = this.encodePath(input.path);
    const body: Record<string, unknown> = {
      message: input.message,
      content: Buffer.from(input.content, 'utf8').toString('base64'),
      sha: input.sha,
    };
    if (input.branch) body.branch = input.branch;
    return this.githubRequest(
      '/repos/' +
        this.repoPath(input.repositoryFullName) +
        '/contents/' +
        encodedPath,
      token,
      { method: 'PUT', body: JSON.stringify(body) },
    );
  }

  async createBranch(input: {
    repositoryFullName: string;
    branchName: string;
    sha: string;
  }): Promise<unknown> {
    this.assertRepository(input.repositoryFullName);
    const token = this.requireToken();
    return this.githubRequest(
      '/repos/' + this.repoPath(input.repositoryFullName) + '/git/refs',
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          ref: 'refs/heads/' + input.branchName,
          sha: input.sha,
        }),
      },
    );
  }

  async deleteBranch(input: {
    repositoryFullName: string;
    branchName: string;
  }): Promise<unknown> {
    this.assertRepository(input.repositoryFullName);
    const token = this.requireToken();
    const branchName = this.requiredString(input.branchName, 'branchName');
    const repository = await this.getRepositoryStatus(input.repositoryFullName);
    if (branchName === repository.repository.defaultBranch) {
      throw new BadRequestException(
        'JARVIS will not delete the repository default branch.',
      );
    }
    return this.githubRequest(
      '/repos/' +
        this.repoPath(input.repositoryFullName) +
        '/git/refs/heads/' +
        encodeURIComponent(branchName),
      token,
      { method: 'DELETE' },
    );
  }

  async mergePullRequest(input: {
    repositoryFullName: string;
    prNumber: number;
    mergeMethod?: 'merge' | 'squash' | 'rebase';
  }): Promise<unknown> {
    this.assertRepository(input.repositoryFullName);
    const token = this.requireToken();
    return this.githubRequest(
      '/repos/' +
        this.repoPath(input.repositoryFullName) +
        '/pulls/' +
        input.prNumber +
        '/merge',
      token,
      {
        method: 'PUT',
        body: JSON.stringify({ merge_method: input.mergeMethod ?? 'squash' }),
      },
    );
  }

  async rerunWorkflowJob(input: {
    repositoryFullName: string;
    jobId: number;
  }): Promise<unknown> {
    this.assertRepository(input.repositoryFullName);
    const token = this.requireToken();
    return this.githubRequest(
      '/repos/' +
        this.repoPath(input.repositoryFullName) +
        '/actions/jobs/' +
        input.jobId +
        '/rerun',
      token,
      { method: 'POST' },
    );
  }

  async getCommitVerification(
    repositoryFullName: string,
    commitSha: string,
  ): Promise<Record<string, unknown>> {
    this.assertRepository(repositoryFullName);
    const token = this.requireToken();
    const base = '/repos/' + this.repoPath(repositoryFullName);
    const checks = (await this.githubRequest(
      base +
        '/commits/' +
        encodeURIComponent(commitSha) +
        '/check-runs?per_page=100',
      token,
      { method: 'GET' },
    )) as Record<string, unknown>;
    const workflows = (await this.githubRequest(
      base +
        '/actions/runs?head_sha=' +
        encodeURIComponent(commitSha) +
        '&per_page=100',
      token,
      { method: 'GET' },
    )) as Record<string, unknown>;
    const checkRuns = Array.isArray(checks.check_runs) ? checks.check_runs : [];
    const workflowRuns = Array.isArray(workflows.workflow_runs)
      ? workflows.workflow_runs
      : [];
    const failures = [...checkRuns, ...workflowRuns].filter((item) => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Record<string, unknown>;
      return [
        'failure',
        'cancelled',
        'timed_out',
        'startup_failure',
        'action_required',
      ].includes(typeof row.conclusion === 'string' ? row.conclusion : '');
    });
    const pending = [...checkRuns, ...workflowRuns].filter((item) => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Record<string, unknown>;
      return (
        typeof row.status === 'string' &&
        row.status !== 'completed' &&
        row.status !== 'success'
      );
    });
    const total = checkRuns.length + workflowRuns.length;
    return {
      verified: total > 0 && failures.length === 0 && pending.length === 0,
      failed: failures.length > 0,
      pending: pending.length > 0,
      commitSha,
      checks: checkRuns.map((item) => {
        const row = item as Record<string, unknown>;
        return {
          name: row.name ?? null,
          status: row.status ?? null,
          conclusion: row.conclusion ?? null,
        };
      }),
      workflows: workflowRuns.map((item) => {
        const row = item as Record<string, unknown>;
        return {
          name: row.name ?? null,
          status: row.status ?? null,
          conclusion: row.conclusion ?? null,
          id: row.id ?? null,
        };
      }),
      checkedAt: new Date().toISOString(),
    };
  }

  getRecoveryPlan(
    toolId: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const repositoryFullName =
      typeof args.repositoryFullName === 'string'
        ? args.repositoryFullName
        : null;
    if (toolId === 'jarvis.owner.github.create-branch') {
      return {
        provider: 'github',
        strategy: 'delete-created-branch',
        executable: true,
        toolId: 'jarvis.owner.github.delete-branch',
        arguments: { repositoryFullName, branchName: args.branchName ?? null },
        approvalRequired: true,
      };
    }
    if (toolId === 'jarvis.owner.github.rerun-workflow') {
      return {
        provider: 'github',
        strategy: 'inspect-and-rerun-workflow-job',
        executable: true,
        toolId: 'jarvis.owner.github.rerun-workflow',
        arguments: { repositoryFullName, jobId: args.jobId ?? null },
        approvalRequired: true,
      };
    }
    if (toolId === 'jarvis.owner.github.merge-pull-request') {
      return {
        provider: 'github',
        strategy: 'revert-merge',
        executable: false,
        reason:
          'A merged pull request must be reverted with a new commit/PR; JARVIS will not rewrite Git history.',
        repositoryFullName,
        prNumber: args.prNumber ?? null,
        approvalRequired: true,
      };
    }
    if (toolId === 'jarvis.owner.github.create-pull-request') {
      return {
        provider: 'github',
        strategy: 'close-created-pull-request',
        executable: true,
        toolId: 'jarvis.owner.github.close-pull-request',
        arguments: { repositoryFullName, prNumber: null },
        approvalRequired: true,
      };
    }
    if (toolId === 'jarvis.owner.github.close-pull-request') {
      return {
        provider: 'github',
        strategy: 'reopen-pull-request',
        executable: false,
        reason: 'Recovery for PR closure is intentionally manual until an explicit reopen mutation is approved.',
        repositoryFullName,
        prNumber: args.prNumber ?? null,
        approvalRequired: true,
      };
    }
    if (toolId === 'jarvis.owner.github.update-file') {
      return {
        provider: 'github',
        strategy: 'restore-file-preimage',
        executable: false,
        reason:
          'Recovery requires the pre-mutation file contents. The current action snapshot intentionally does not persist file contents for recovery.',
        repositoryFullName,
        path: args.path ?? null,
        branch: args.branch ?? null,
        approvalRequired: true,
      };
    }
    return {
      provider: 'github',
      strategy: 'manual-review',
      executable: false,
      approvalRequired: true,
    };
  }

  async verifyMutation(
    toolId: string,
    args: Record<string, unknown>,
    result?: unknown,
  ): Promise<Record<string, unknown>> {
    const repositoryFullName = this.requiredString(
      args.repositoryFullName,
      'repositoryFullName',
    );
    this.assertRepository(repositoryFullName);
    const token = this.requireToken();

    if (toolId === 'jarvis.owner.github.update-file') {
      const path = this.requiredString(args.path, 'path');
      const expectedContent = this.requiredStringAllowEmpty(
        args.content,
        'content',
      );
      const ref =
        typeof args.branch === 'string' && args.branch.trim()
          ? args.branch.trim()
          : undefined;
      const file = (await this.githubRequest(
        '/repos/' +
          this.repoPath(repositoryFullName) +
          '/contents/' +
          this.encodePath(path) +
          (ref ? '?ref=' + encodeURIComponent(ref) : ''),
        token,
        { method: 'GET' },
      )) as Record<string, unknown>;
      const content =
        typeof file.content === 'string'
          ? Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString(
              'utf8',
            )
          : '';
      const verified = content === expectedContent;
      return {
        verified,
        mode: 'github-file-content',
        path,
        ref: ref ?? 'default-branch',
        observedSha: file.sha ?? null,
        checkedAt: new Date().toISOString(),
      };
    }

    if (toolId === 'jarvis.owner.github.create-branch') {
      const branchName = this.requiredString(args.branchName, 'branchName');
      const expectedSha = this.requiredString(args.sha, 'sha');
      const branch = (await this.githubRequest(
        '/repos/' +
          this.repoPath(repositoryFullName) +
          '/git/ref/heads/' +
          encodeURIComponent(branchName),
        token,
        { method: 'GET' },
      )) as Record<string, unknown>;
      const observedSha =
        branch.object && typeof branch.object === 'object'
          ? (branch.object as Record<string, unknown>).sha
          : null;
      return {
        verified: observedSha === expectedSha,
        mode: 'github-branch-ref',
        branch: branchName,
        observedSha: observedSha ?? null,
        checkedAt: new Date().toISOString(),
      };
    }

    if (toolId === 'jarvis.owner.github.delete-branch') {
      const branchName = this.requiredString(args.branchName, 'branchName');
      try {
        await this.githubRequest(
          '/repos/' +
            this.repoPath(repositoryFullName) +
            '/git/ref/heads/' +
            encodeURIComponent(branchName),
          token,
          { method: 'GET' },
        );
        return {
          verified: false,
          mode: 'github-branch-deletion',
          branch: branchName,
          checkedAt: new Date().toISOString(),
        };
      } catch (error) {
        if (
          error instanceof ServiceUnavailableException &&
          error.message.includes('HTTP 404')
        ) {
          return {
            verified: true,
            mode: 'github-branch-deletion',
            branch: branchName,
            checkedAt: new Date().toISOString(),
          };
        }
        throw error;
      }
    }

    if (toolId === 'jarvis.owner.github.create-pull-request') {
      const expectedHead = this.requiredString(args.head, 'head');
      const expectedBase = this.requiredString(args.base, 'base');
      const created = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      const prNumber = this.optionalResultNumber(created, 'number');
      const observed = prNumber
        ? await this.getPullRequest(repositoryFullName, prNumber)
        : null;
      const observedHead = observed && observed.head && typeof observed.head === 'object'
        ? (observed.head as Record<string, unknown>).ref
        : null;
      const observedBase = observed && observed.base && typeof observed.base === 'object'
        ? (observed.base as Record<string, unknown>).ref
        : null;
      return {
        verified: !!observed && observed.state === 'open' && observedHead === expectedHead && observedBase === expectedBase,
        mode: 'github-pr-creation',
        prNumber,
        observedHead,
        observedBase,
        checkedAt: new Date().toISOString(),
      };
    }

    if (toolId === 'jarvis.owner.github.close-pull-request') {
      const prNumber = this.requiredInteger(args.prNumber, 'prNumber');
      const pr = await this.getPullRequest(repositoryFullName, prNumber);
      return {
        verified: pr.state === 'closed',
        mode: 'github-pr-closure',
        prNumber,
        state: pr.state ?? null,
        checkedAt: new Date().toISOString(),
      };
    }

    if (toolId === 'jarvis.owner.github.merge-pull-request') {
      const prNumber = this.requiredInteger(args.prNumber, 'prNumber');
      const pr = (await this.githubRequest(
        '/repos/' + this.repoPath(repositoryFullName) + '/pulls/' + prNumber,
        token,
        { method: 'GET' },
      )) as Record<string, unknown>;
      const merged = pr.merged === true;
      const expectedSha = this.optionalResultString(result, 'sha');
      const observedSha =
        typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null;
      return {
        verified: merged && (!expectedSha || expectedSha === observedSha),
        mode: 'github-pr-merge',
        prNumber,
        merged,
        observedSha,
        checkedAt: new Date().toISOString(),
      };
    }

    if (toolId === 'jarvis.owner.github.rerun-workflow') {
      const jobId = this.requiredInteger(args.jobId, 'jobId');
      const job = (await this.githubRequest(
        '/repos/' +
          this.repoPath(repositoryFullName) +
          '/actions/jobs/' +
          jobId,
        token,
        { method: 'GET' },
      )) as Record<string, unknown>;
      const status = typeof job.status === 'string' ? job.status : null;
      const conclusion =
        typeof job.conclusion === 'string' ? job.conclusion : null;
      return {
        verified:
          status === 'queued' ||
          status === 'in_progress' ||
          conclusion === 'success',
        mode: 'github-workflow-job',
        jobId,
        status,
        conclusion,
        checkedAt: new Date().toISOString(),
      };
    }

    throw new BadRequestException(
      'Unsupported GitHub mutation verification tool.',
    );
  }

  private assertRepository(repositoryFullName: string): void {
    const fullName = repositoryFullName.trim();
    if (!REPOSITORY_PATTERN.test(fullName)) {
      throw new BadRequestException(
        'GitHub repository must use the owner/name format.',
      );
    }
    const owner = fullName.split('/')[0];
    if (!this.getAllowedOwners().includes(owner.toLowerCase())) {
      throw new BadRequestException(
        'GitHub repository owner is not authorized for JARVIS.',
      );
    }
  }

  private requireToken(): string {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new ServiceUnavailableException(
        'GitHub owner integration is not configured.',
      );
    }
    return token;
  }

  private repoPath(repositoryFullName: string): string {
    const parts = repositoryFullName.trim().split('/');
    return encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]);
  }

  private encodePath(path: string): string {
    const normalized = path.trim().replace(/^\/+/, '');
    if (!normalized || normalized.includes('..') || normalized.includes('\\')) {
      throw new BadRequestException('GitHub file path is invalid.');
    }
    return normalized
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  private async githubRequest(
    path: string,
    token: string,
    init: RequestInit,
  ): Promise<unknown> {
    const response = await fetch(GITHUB_API_BASE + path, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    const raw = await response.text();
    let data: unknown = {};
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw };
      }
    }
    if (!response.ok) {
      const providerMessage =
        data && typeof data === 'object' && typeof (data as Record<string, unknown>).message === 'string'
          ? ((data as Record<string, unknown>).message as string)
          : undefined;
      const documentationUrl =
        data && typeof data === 'object' && typeof (data as Record<string, unknown>).documentation_url === 'string'
          ? ((data as Record<string, unknown>).documentation_url as string)
          : undefined;
      const detail = [
        providerMessage ? ' ' + providerMessage : '',
        documentationUrl ? ' Documentation: ' + documentationUrl : '',
      ].join('');
      throw new ServiceUnavailableException(
        'GitHub mutation failed (HTTP ' + response.status + ').' + detail,
      );
    }
    return data;
  }

  private requiredStringAllowEmpty(value: unknown, field: string): string {
    if (typeof value !== 'string')
      throw new BadRequestException('GitHub ' + field + ' is required.');
    return value;
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException('GitHub ' + field + ' is required.');
    return value.trim();
  }

  private requiredInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
      throw new BadRequestException('GitHub ' + field + ' is invalid.');
    return value;
  }

  private optionalResultNumber(value: unknown, key: string): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : undefined;
  }

  private optionalResultString(
    value: unknown,
    key: string,
  ): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'string' && candidate.trim()
      ? candidate.trim()
      : undefined;
  }

  private getAllowedOwners(): string[] {
    const configured = process.env.JARVIS_GITHUB_ALLOWED_OWNERS?.trim();
    const raw = configured || 'Stackaura-Payments';
    return raw
      .split(',')
      .map((owner) => owner.trim().toLowerCase())
      .filter(Boolean);
  }

  private stringField(value: unknown, field: string): string {
    if (typeof value !== 'string') {
      throw new ServiceUnavailableException(
        `GitHub response missing ${field}.`,
      );
    }
    return value;
  }

  private objectStringField(value: unknown, field: string): string {
    if (!value || typeof value !== 'object') {
      throw new ServiceUnavailableException(`GitHub response missing owner.`);
    }
    return this.stringField(
      (value as Record<string, unknown>)[field],
      `owner.${field}`,
    );
  }

  private numberField(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ServiceUnavailableException(
        `GitHub response missing ${field}.`,
      );
    }
    return value;
  }

  private booleanField(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
      throw new ServiceUnavailableException(
        `GitHub response missing ${field}.`,
      );
    }
    return value;
  }
}
