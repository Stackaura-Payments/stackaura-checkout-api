import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';

const GITHUB_API = 'https://api.github.com';

export interface SourceFileFix {
  path: string;
  content: string;
  sha: string;
  message: string;
}

export interface SourceInspection {
  previousKnownGoodCommit: string | null;
  fileComparisons: Array<{
    path: string;
    currentSha: string;
    previousSha: string | null;
    changed: boolean;
    changeSummary: string;
  }>;
  findings: string[];
  fixes: SourceFileFix[];
}

@Injectable()
export class EngineeringSourceInspectionService {
  async inspect(
    repository: string,
    commitSha: string,
    relevantFiles: string[],
  ): Promise<SourceInspection> {
    this.assertRepository(repository);
    const commit = await this.githubGet(
      '/repos/' + repository + '/commits/' + encodeURIComponent(commitSha),
    ) as Record<string, unknown>;
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    const previous = parents[0] && typeof parents[0] === 'object'
      ? (parents[0] as Record<string, unknown>).sha
      : null;
    if (typeof previous !== 'string') {
      return { previousKnownGoodCommit: null, fileComparisons: [], findings: [], fixes: [] };
    }

    const findings: string[] = [];
    const fileComparisons: SourceInspection['fileComparisons'] = [];
    const fixes: SourceFileFix[] = [];

    for (const path of relevantFiles.slice(0, 10)) {
      const current = await this.getFile(repository, path, commitSha);
      const old = await this.getFile(repository, path, previous).catch(() => null);
      const changed = !old || old.content !== current.content;
      fileComparisons.push({
        path,
        currentSha: current.sha,
        previousSha: old?.sha ?? null,
        changed,
        changeSummary: old
          ? (changed ? 'File content differs from the parent revision.' : 'No content difference from the parent revision.')
          : 'File did not exist at the parent revision.',
      });
      if (
        changed &&
        old &&
        /package\.json$|package-lock\.json$|npm-shrinkwrap\.json$/i.test(path)
      ) {
        const introducedPlatformPackage =
          /@next\/swc-(?:darwin|win32|linux)-/i.test(current.content) &&
          !/@next\/swc-(?:darwin|win32|linux)-/i.test(old.content);

        if (introducedPlatformPackage) {
          findings.push(
            'High-confidence source finding: ' +
            path +
            ' introduced a platform-specific Next.js SWC package after the last known-good revision. ' +
            'The failing Vercel install is therefore most likely caused by this dependency being pinned in the project manifest.',
          );

          const cleaned = current.content
            .replace(
              /\n\s*"@next\/swc-(?:darwin|win32|linux)-[^"\n]+"\s*:\s*"[^"]+",?/g,
              '',
            );

          if (cleaned !== current.content) {
            fixes.push({
              path,
              content: /package-lock\.json$|npm-shrinkwrap\.json$/i.test(path) ? old.content : cleaned,
              sha: current.sha,
              message: /package-lock\.json$|npm-shrinkwrap\.json$/i.test(path)
                ? 'fix(jarvis): restore lockfile to the last known-good dependency graph'
                : 'fix(jarvis): remove platform-specific SWC dependency from ' + path,
            });
          }
        }
      }
    }

    if (findings.some((finding) => /High-confidence source finding/i.test(finding))) {
      findings.push(
        'Exact remediation: remove the platform-specific SWC dependency from the project manifest and lockfile, then allow Next.js to resolve the appropriate platform package during the Vercel build.',
      );
    }

    return {
      previousKnownGoodCommit: previous,
      fileComparisons,
      findings,
      fixes,
    };
  }
  private async getFile(
    repository: string,
    path: string,
    ref: string,
  ): Promise<{ sha: string; content: string }> {
    const response = await this.githubGet(
      '/repos/' +
        repository +
        '/contents/' +
        this.encodePath(path) +
        '?ref=' +
        encodeURIComponent(ref),
    ) as Record<string, unknown>;

    if (Array.isArray(response)) {
      throw new BadRequestException('GitHub source path is a directory.');
    }

    const encoded = typeof response.content === 'string'
      ? response.content.replace(/\s/g, '')
      : null;

    if (!encoded) {
      throw new ServiceUnavailableException('GitHub source content is unavailable.');
    }

    return {
      sha: this.requiredString(response.sha, 'content.sha'),
      content: Buffer.from(encoded, 'base64').toString('utf8'),
    };
  }

  private async githubGet(path: string): Promise<unknown> {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new ServiceUnavailableException('GitHub owner integration is not configured.');
    }

    const response = await fetch(GITHUB_API + path, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new ServiceUnavailableException(
        'GitHub source inspection failed (HTTP ' + response.status + ').',
      );
    }

    return response.json();
  }
  private assertRepository(repository: string): void {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new BadRequestException('GitHub repository must use the owner/name format.');
    }
    const owner = repository.split('/')[0].toLowerCase();
    const allowed = (process.env.JARVIS_GITHUB_ALLOWED_OWNERS || 'Stackaura-Payments')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(owner)) {
      throw new BadRequestException('GitHub repository owner is not authorized for JARVIS.');
    }
  }

  private encodePath(path: string): string {
    const normalized = path.trim().replace(/^\/+/, '');
    if (!normalized || normalized.includes('..') || normalized.includes('\\')) {
      throw new BadRequestException('GitHub source path is invalid.');
    }
    return normalized
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new ServiceUnavailableException('GitHub response missing ' + field + '.');
    }
    return value.trim();
  }
}
