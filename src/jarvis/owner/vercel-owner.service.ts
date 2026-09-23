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
        createdAt: this.createdAt(deployment.createdAt ?? deployment.created),
        commitSha: this.metaString(deployment.meta, 'githubCommitSha'),
        commitMessage: this.metaString(deployment.meta, 'githubCommitMessage'),
        branch: this.metaString(deployment.meta, 'githubCommitRef'),
      },
      provider: 'vercel',
      readOnly: true,
      mutationsEnabled: false,
    };
  }


  async listDeployments(limit = 10): Promise<Array<{ id: string; state: string; target: string | null; createdAt: string; branch: string | null; commitSha: string | null }>> {
    const token = this.requireToken();
    const projectId = process.env.VERCEL_PROJECT_ID?.trim();
    if (!projectId) throw new ServiceUnavailableException('Vercel project is not configured for JARVIS.');
    const teamId = process.env.VERCEL_TEAM_ID?.trim();
    const query = new URLSearchParams({ projectId, limit: String(Math.min(Math.max(limit, 1), 50)) });
    if (teamId) query.set('teamId', teamId);
    const response = await fetch(VERCEL_API_BASE + '/v6/deployments?' + query.toString(), {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new ServiceUnavailableException('Vercel deployment list could not be retrieved (HTTP ' + response.status + ').');
    const data = await response.json() as Record<string, unknown>;
    const deployments = Array.isArray(data.deployments) ? data.deployments : [];
    return deployments.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object').map((item) => ({
      id: this.stringField(item.uid ?? item.id, 'id'), state: typeof item.state === 'string' ? item.state : 'UNKNOWN',
      target: typeof item.target === 'string' ? item.target : null, createdAt: this.createdAt(item.created), branch: this.metaString(item.meta, 'githubCommitRef'), commitSha: this.metaString(item.meta, 'githubCommitSha'),
    }));
  }

  async getDeployment(deploymentId: string): Promise<VercelDeploymentSnapshot['deployment'] & { errorCode: string | null; errorMessage: string | null; errorStep: string | null }> {
    const token = this.requireToken();
    const teamId = process.env.VERCEL_TEAM_ID?.trim();
    const query = teamId ? '?teamId=' + encodeURIComponent(teamId) : '';
    const response = await fetch(VERCEL_API_BASE + '/v13/deployments/' + encodeURIComponent(deploymentId) + query, {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new ServiceUnavailableException('Vercel deployment details could not be retrieved (HTTP ' + response.status + ').');
    const data = await response.json() as Record<string, unknown>;
    const meta = data.meta;
    return {
      id: this.stringField(data.uid ?? data.id, 'id'), projectId: this.stringField(data.projectId ?? process.env.VERCEL_PROJECT_ID, 'projectId'),
      url: this.stringField(data.url, 'url'), state: typeof data.readyState === 'string' ? data.readyState : this.stringField(data.state, 'state'),
      target: typeof data.target === 'string' ? data.target : null, createdAt: this.createdAt(data.createdAt ?? data.created),
      commitSha: this.metaString(meta, 'githubCommitSha'), commitMessage: this.metaString(meta, 'githubCommitMessage'), branch: this.metaString(meta, 'githubCommitRef'),
      errorCode: typeof data.errorCode === 'string' ? data.errorCode : null, errorMessage: typeof data.errorMessage === 'string' ? data.errorMessage : null,
      errorStep: typeof data.errorStep === 'string' ? data.errorStep : null,
    };
  }

  async getBuildEvents(deploymentId: string): Promise<Array<{ type: string; text: string; createdAt: string }>> {
    const token = this.requireToken();
    const teamId = process.env.VERCEL_TEAM_ID?.trim();
    const query = new URLSearchParams({ direction: 'forward', follow: '0', format: 'json' });
    if (teamId) query.set('teamId', teamId);
    const response = await fetch(VERCEL_API_BASE + '/v3/deployments/' + encodeURIComponent(deploymentId) + '/events?' + query.toString(), {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const data = await response.json() as unknown;
    const rows: unknown[] = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).events) ? ((data as Record<string, unknown>).events as unknown[]) : [];
    return rows.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object').map((item) => ({
      type: typeof item.type === 'string' ? item.type : 'log',
      text: typeof item.payload === 'string' ? item.payload : typeof item.text === 'string' ? item.text : JSON.stringify(item.payload ?? item),
      createdAt: typeof item.createdAt === 'number' ? new Date(item.createdAt).toISOString() : new Date().toISOString(),
    }));
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
