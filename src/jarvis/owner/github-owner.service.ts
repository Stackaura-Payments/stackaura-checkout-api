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
