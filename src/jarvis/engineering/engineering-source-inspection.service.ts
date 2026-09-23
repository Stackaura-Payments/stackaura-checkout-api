import { BadRequestException, Injectable } from '@nestjs/common';
import { GitHubOwnerService } from '../owner/github-owner.service';

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
  constructor(private readonly github: GitHubOwnerService) {}

  async inspect(
    repository: string,
    commitSha: string,
    relevantFiles: string[],
    previousKnownGoodCommit?: string | null,
  ): Promise<SourceInspection> {
    const commit = await this.github.getCommitSnapshot(repository, commitSha);
    const previous = previousKnownGoodCommit ?? commit.parentSha;
    if (!previous) {
      return { previousKnownGoodCommit: null, fileComparisons: [], findings: [], fixes: [] };
    }

    const findings: string[] = [];
    const fileComparisons: SourceInspection['fileComparisons'] = [];
    const fixes: SourceFileFix[] = [];

    for (const path of relevantFiles.slice(0, 10)) {
      const current = await this.github.getFile(repository, path, commitSha);
      const old = await this.github.getFile(repository, path, previous).catch(() => null);
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

    for (const patch of commit.patches) {
      if (patch.patch && /error|fail|throw|timeout|undefined|null/i.test(patch.patch) && !findings.some((finding) => finding.includes(patch.path))) {
        findings.push('Source-change candidate: ' + patch.path + ' contains a changed failure-sensitive line in the deployed commit. This is evidence for review, not proof of causality.');
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
}
