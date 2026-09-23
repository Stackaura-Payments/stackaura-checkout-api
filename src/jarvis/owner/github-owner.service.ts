import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';

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
  async getRepositoryStatus(repositoryFullName: string): Promise<GitHubRepositorySnapshot> {
    const fullName = repositoryFullName.trim();
    if (!REPOSITORY_PATTERN.test(fullName)) {
      throw new BadRequestException('GitHub repository must use the owner/name format.');
    }

    const [owner] = fullName.split('/');
    const allowedOwners = this.getAllowedOwners();
    if (!allowedOwners.includes(owner.toLowerCase())) {
      throw new BadRequestException('GitHub repository owner is not authorized for JARVIS.');
    }

    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new ServiceUnavailableException('GitHub owner integration is not configured.');
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
        throw new BadRequestException('GitHub repository was not found or is not accessible.');
      }
      throw new ServiceUnavailableException('GitHub repository status could not be retrieved.');
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
      '/repos/' + this.repoPath(input.repositoryFullName) + '/contents/' + encodedPath,
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
        body: JSON.stringify({ ref: 'refs/heads/' + input.branchName, sha: input.sha }),
      },
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
      '/repos/' + this.repoPath(input.repositoryFullName) + '/pulls/' + input.prNumber + '/merge',
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
      '/repos/' + this.repoPath(input.repositoryFullName) + '/actions/jobs/' + input.jobId + '/rerun',
      token,
      { method: 'POST' },
    );
  }

  private assertRepository(repositoryFullName: string): void {
    const fullName = repositoryFullName.trim();
    if (!REPOSITORY_PATTERN.test(fullName)) {
      throw new BadRequestException('GitHub repository must use the owner/name format.');
    }
    const owner = fullName.split('/')[0];
    if (!this.getAllowedOwners().includes(owner.toLowerCase())) {
      throw new BadRequestException('GitHub repository owner is not authorized for JARVIS.');
    }
  }

  private requireToken(): string {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new ServiceUnavailableException('GitHub owner integration is not configured.');
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
    return normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  }

  private async githubRequest(path: string, token: string, init: RequestInit): Promise<unknown> {
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
      try { data = JSON.parse(raw); } catch { data = { raw }; }
    }
    if (!response.ok) {
      throw new ServiceUnavailableException('GitHub mutation failed (HTTP ' + response.status + ').');
    }
    return data;
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
      throw new ServiceUnavailableException(`GitHub response missing ${field}.`);
    }
    return value;
  }

  private objectStringField(value: unknown, field: string): string {
    if (!value || typeof value !== 'object') {
      throw new ServiceUnavailableException(`GitHub response missing owner.`);
    }
    return this.stringField((value as Record<string, unknown>)[field], `owner.${field}`);
  }

  private numberField(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ServiceUnavailableException(`GitHub response missing ${field}.`);
    }
    return value;
  }

  private booleanField(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
      throw new ServiceUnavailableException(`GitHub response missing ${field}.`);
    }
    return value;
  }
}
