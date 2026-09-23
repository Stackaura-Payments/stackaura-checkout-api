import { Injectable, ServiceUnavailableException } from '@nestjs/common';

const VERCEL_API_BASE = 'https://api.vercel.com';

export interface VercelDeploymentSnapshot {
  deployment: {
    id: string;
    projectId: string;
    url: string;
    state: string;
    target: string | null;
    createdAt: string;
    commitSha: string | null;
    commitMessage: string | null;
    branch: string | null;
  };
  provider: 'vercel';
  readOnly: true;
  mutationsEnabled: false;
}

@Injectable()
export class VercelOwnerService {
  async getLatestDeployment(): Promise<VercelDeploymentSnapshot> {
    const token = process.env.VERCEL_TOKEN?.trim();
    const projectId = process.env.VERCEL_PROJECT_ID?.trim();

    if (!token || !projectId) {
      throw new ServiceUnavailableException(
        'Vercel owner integration is not configured.',
      );
    }

    const teamId = process.env.VERCEL_TEAM_ID?.trim();
    const query = new URLSearchParams({
      projectId,
      limit: '1',
    });

    if (teamId) {
      query.set('teamId', teamId);
    }

    const response = await fetch(
      `${VERCEL_API_BASE}/v6/deployments?${query.toString()}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!response.ok) {
      if (response.status === 401) {
        throw new ServiceUnavailableException(
          'Vercel deployment status could not be retrieved: Vercel rejected the owner token (HTTP 401).',
        );
      }

      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Vercel deployment status could not be retrieved: the owner token lacks access to the selected Vercel project or team (HTTP 403).',
        );
      }

      if (response.status === 404) {
        throw new ServiceUnavailableException(
          'Vercel deployment status could not be retrieved: the selected Vercel project was not found or is not accessible (HTTP 404).',
        );
      }

      if (response.status === 429) {
        throw new ServiceUnavailableException(
          'Vercel deployment status could not be retrieved: Vercel rate-limited the request (HTTP 429).',
        );
      }

      throw new ServiceUnavailableException(
        `Vercel deployment status could not be retrieved (HTTP ${response.status}).`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const deployments = Array.isArray(data.deployments)
      ? data.deployments
      : [];

    if (!deployments.length || !deployments[0] || typeof deployments[0] !== 'object') {
      throw new ServiceUnavailableException(
        'Vercel returned no deployment status.',
      );
    }

    const deployment = deployments[0] as Record<string, unknown>;

    return {
      deployment: {
        id: this.stringField(deployment.uid ?? deployment.id, 'id'),
        projectId: this.stringField(
          deployment.projectId ?? projectId,
          'projectId',
        ),
        url: this.stringField(deployment.url, 'url'),
        state: this.stringField(deployment.state, 'state'),
        target:
          typeof deployment.target === 'string' ? deployment.target : null,
        createdAt: this.createdAt(deployment.created),
        commitSha: this.metaString(deployment.meta, 'githubCommitSha'),
        commitMessage: this.metaString(deployment.meta, 'githubCommitMessage'),
        branch: this.metaString(deployment.meta, 'githubCommitRef'),
      },
      provider: 'vercel',
      readOnly: true,
      mutationsEnabled: false,
    };
  }

  private metaString(value: unknown, key: string): string | null {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'string' ? candidate : null;
  }

  private createdAt(value: unknown): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ServiceUnavailableException('Vercel response missing created timestamp.');
    }
    return new Date(value).toISOString();
  }

  private stringField(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new ServiceUnavailableException(`Vercel response missing ${field}.`);
    }
    return value;
  }
}
