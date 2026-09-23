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


  async deploy(input: {
    projectId: string;
    target?: 'production' | 'preview';
    ref?: string;
  }): Promise<unknown> {
    const token = this.requireToken();
    const configuredProject = process.env.VERCEL_PROJECT_ID?.trim();
    if (!configuredProject || input.projectId !== configuredProject) {
      throw new ServiceUnavailableException('Vercel project is not authorized for this JARVIS installation.');
    }

    const teamId = process.env.VERCEL_TEAM_ID?.trim();
    const query = teamId ? '?teamId=' + encodeURIComponent(teamId) : '';
    const body: Record<string, unknown> = {
      name: input.projectId,
      project: input.projectId,
      target: input.target ?? 'production',
    };
    if (input.ref) {
      body.gitSource = { type: 'github', ref: input.ref };
    }

    const response = await fetch(VERCEL_API_BASE + '/v13/deployments' + query, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    const raw = await response.text();
    let data: unknown = {};
    if (raw) {
      try { data = JSON.parse(raw); } catch { data = { raw }; }
    }
    if (!response.ok) {
      throw new ServiceUnavailableException('Vercel deployment mutation failed (HTTP ' + response.status + ').');
    }
    return data;
  }

  async verifyDeployment(deploymentId: string): Promise<Record<string, unknown>> {
    const token = this.requireToken();
    const teamId = process.env.VERCEL_TEAM_ID?.trim();
    const query = teamId ? '?teamId=' + encodeURIComponent(teamId) : '';
    const response = await fetch(
      VERCEL_API_BASE + '/v13/deployments/' + encodeURIComponent(deploymentId) + query,
      {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(8000),
      },
    );
    const raw = await response.text();
    let data: Record<string, unknown> = {};
    if (raw) {
      try { data = JSON.parse(raw) as Record<string, unknown>; } catch { data = {}; }
    }
    if (!response.ok) {
      return { verified: false, provider: 'vercel', statusCode: response.status };
    }
    const state = typeof data.readyState === 'string' ? data.readyState : data.state;
    return {
      verified: state === 'READY',
      provider: 'vercel',
      deploymentId,
      state: typeof state === 'string' ? state : 'UNKNOWN',
      url: typeof data.url === 'string' ? data.url : null,
      checkedAt: new Date().toISOString(),
    };
  }

  private requireToken(): string {
    const token = process.env.VERCEL_TOKEN?.trim();
    if (!token) {
      throw new ServiceUnavailableException('Vercel owner integration is not configured.');
    }
    return token;
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
