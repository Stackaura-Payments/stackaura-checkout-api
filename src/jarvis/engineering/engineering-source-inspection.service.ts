import { Injectable } from '@nestjs/common';
import { GitHubOwnerService } from '../owner/github-owner.service';

export interface SourceFileFix {
  path: string;
  content: string;
  sha: string;
  message: string;
  rationale: string;
  evidence: string[];
}

export interface SourceInspection {
  previousKnownGoodCommit: string | null;
  failureDomain: 'dependency-installation' | 'build' | 'runtime' | 'configuration' | 'unknown';
  rootCause: string | null;
  confidence: 'high' | 'medium' | 'low';
  exactFix: string | null;
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
    failureDomain: SourceInspection['failureDomain'] = 'unknown',
    buildLogText = '',
  ): Promise<SourceInspection> {
    const commit = await this.github.getCommitSnapshot(repository, commitSha);
    const previous = previousKnownGoodCommit ?? commit.parentSha;
    if (!previous) {
      return {
        previousKnownGoodCommit: null,
        failureDomain,
        rootCause: null,
        confidence: 'low',
        exactFix: null,
        fileComparisons: [],
        findings: [],
        fixes: [],
      };
    }

    const findings: string[] = [];
    const fileComparisons: SourceInspection['fileComparisons'] = [];
    const fixes: SourceFileFix[] = [];

    // Failure-domain-aware inspection: only inspect files that can plausibly explain
    // the provider failure. Do not infer causality from arbitrary words like "error"
    // or "throw" appearing in changed application source.
    const candidateFiles = failureDomain === 'dependency-installation'
      ? ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']
      : relevantFiles;
    const prioritizedFiles = this.prioritizeFiles(candidateFiles, failureDomain).slice(0, 10);
    const contents = new Map<string, { current: { sha: string; content: string }; old: { sha: string; content: string } | null }>();

    for (const path of prioritizedFiles) {
      const current = await this.github.getFile(repository, path, commitSha).catch(() => null);
      if (!current) continue;
      const old = await this.github.getFile(repository, path, previous).catch(() => null);
      contents.set(path, { current, old });
      const changed = !old || old.content !== current.content;
      fileComparisons.push({
        path,
        currentSha: current.sha,
        previousSha: old?.sha ?? null,
        changed,
        changeSummary: old
          ? (changed ? 'File content differs from the deployment-aware known-good revision.' : 'No content difference from the deployment-aware known-good revision.')
          : 'File did not exist at the deployment-aware known-good revision.',
      });
    }

    if (failureDomain === 'dependency-installation') {
      const dependencyResult = this.analyzeDependencyInstallation(contents);
      findings.push(...dependencyResult.findings);
      fixes.push(...dependencyResult.fixes);
      return {
        previousKnownGoodCommit: previous,
        failureDomain,
        rootCause: dependencyResult.rootCause,
        confidence: dependencyResult.confidence,
        exactFix: dependencyResult.exactFix,
        fileComparisons,
        findings,
        fixes,
      };
    }

    if (failureDomain === 'build') {
      const buildResult = this.analyzeBuildFailure(contents, buildLogText);
      findings.push(...buildResult.findings);
      fixes.push(...buildResult.fixes);
      return {
        previousKnownGoodCommit: previous,
        failureDomain,
        rootCause: buildResult.rootCause,
        confidence: buildResult.confidence,
        exactFix: buildResult.exactFix,
        fileComparisons,
        findings,
        fixes,
      };
    }

    return {
      previousKnownGoodCommit: previous,
      failureDomain,
      rootCause: null,
      confidence: 'low',
      exactFix: null,
      fileComparisons,
      findings,
      fixes,
    };
  }

  private analyzeBuildFailure(
    contents: Map<string, { current: { sha: string; content: string }; old: { sha: string; content: string } | null }>,
    buildLogText: string,
  ) {
    const findings: string[] = [];
    const fixes: SourceFileFix[] = [];
    const referenced = [...contents.keys()].filter((path) => {
      const lowerLog = buildLogText.toLowerCase();
      return lowerLog.includes(path.toLowerCase()) || lowerLog.includes(path.split('/').pop()?.toLowerCase() ?? path.toLowerCase());
    });

    const errors = this.extractBuildErrors(buildLogText);
    if (referenced.length) {
      findings.push('Build-log/source correlation: Vercel explicitly referenced changed file(s) ' + referenced.join(', ') + '.');
      const changed = referenced.filter((path) => {
        const entry = contents.get(path);
        return !!entry?.old && entry.current.content !== entry.old.content;
      });
      if (changed.length) {
        findings.push('Source correlation confirmed: the Vercel-referenced file(s) differ from the deployment-aware known-good revision: ' + changed.join(', ') + '.');
      }
    }

    const fixCandidate = this.generateEvidenceBackedLineFix(contents, errors);
    if (fixCandidate) {
      fixes.push(fixCandidate.fix);
      findings.push(fixCandidate.finding);
      return {
        findings,
        fixes,
        rootCause: fixCandidate.rootCause,
        confidence: 'high' as const,
        exactFix: fixCandidate.fix.path + ': ' + fixCandidate.fix.message + ' ' + fixCandidate.fix.rationale,
      };
    }

    if (referenced.length) {
      return {
        findings,
        fixes,
        rootCause: errors.length
          ? errors.join(' | ')
          : 'The Vercel build log references changed source file(s), but no safely reversible source-level fix could be generated.',
        confidence: 'medium' as const,
        exactFix: null,
      };
    }

    if (contents.size === 1) {
      const [path] = contents.keys();
      const entry = contents.get(path);
      if (entry?.old && entry.current.content !== entry.old.content) {
        findings.push('Build/source correlation candidate: ' + path + ' is the only changed source file inspected for this failing revision and differs from the deployment-aware known-good revision.');
        return {
          findings,
          fixes,
          rootCause: 'The failing revision changed ' + path + ', but the Vercel build log did not expose a source-level location. Exact causality remains unproven.',
          confidence: 'medium' as const,
          exactFix: null,
        };
      }
    }

    return {
      findings: ['Vercel reported a build failure, but the available build log did not identify a changed source file strongly enough to establish causality.'],
      fixes,
      rootCause: null,
      confidence: 'low' as const,
      exactFix: null,
    };
  }

  private extractBuildErrors(buildLogText: string): string[] {
    return buildLogText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /(?:Type error|TS\\d+|Module not found|Cannot find module|Cannot find name|SyntaxError|Invalid configuration|configuration error|is not assignable|does not exist on type)/i.test(line))
      .slice(-12);
  }

  private generateEvidenceBackedLineFix(
    contents: Map<string, { current: { sha: string; content: string }; old: { sha: string; content: string } | null }>,
    errors: string[],
  ): { fix: SourceFileFix; finding: string; rootCause: string } | null {
    for (const error of errors) {
      const location = this.parseSourceLocation(error);
      if (!location) continue;
      const entry = contents.get(location.path);
      if (!entry?.old) continue;

      const currentLines = entry.current.content.split(/\r?\n/);
      const oldLines = entry.old.content.split(/\r?\n/);
      const currentLine = currentLines[location.line - 1];
      const oldLine = oldLines[location.line - 1];
      if (currentLine === undefined || oldLine === undefined || currentLine === oldLine) continue;

      // Safety rule: only revert the exact failing line when the previous known-good
      // revision has a different line at the same source location. This is the
      // smallest deterministic repair supported by provider evidence.
      const nextLines = [...currentLines];
      nextLines[location.line - 1] = oldLine;
      const content = nextLines.join('\n');
      const fix: SourceFileFix = {
        path: location.path,
        content,
        sha: entry.current.sha,
        message: 'fix(jarvis): restore failing line from known-good revision',
        rationale: 'Replace only the compiler-reported failing line with the corresponding line from the previous READY revision; no unrelated source lines are changed.',
        evidence: [
          'Vercel build error: ' + error,
          'Failing revision: current source at ' + location.path + ':' + location.line,
          'Known-good revision: corresponding source line differs at the same location.',
        ],
      };
      return {
        fix,
        finding: 'Evidence-backed exact fix generated for ' + location.path + ':' + location.line + ': the compiler-reported line differs from the same line in the previous known-good revision. The proposed repair changes one line only.',
        rootCause: error,
      };
    }
    return null;
  }

  private parseSourceLocation(error: string): { path: string; line: number; column?: number } | null {
    const match = error.match(/(?:^|[\s(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+)[:(](\\d+)(?::(\\d+))?\)?/);
    if (!match) return null;
    const path = match[1];
    if (!path.includes('/') && !/\.(?:tsx?|jsx?|mjs|cjs|json)$/i.test(path)) return null;
    return { path, line: Number(match[2]), column: match[3] ? Number(match[3]) : undefined };
  }

  private prioritizeFiles(files: string[], failureDomain: SourceInspection['failureDomain']): string[] {
    if (failureDomain === 'dependency-installation') {
      const dependencyFiles = [
        'package.json',
        'package-lock.json',
        'npm-shrinkwrap.json',
        'pnpm-lock.yaml',
        'yarn.lock',
      ];
      const normalized = new Set(files.map((file) => file.toLowerCase()));
      // Dependency failures must inspect the manifests even when the generic
      // changed-file correlation did not return them. This is deterministic by
      // failure domain rather than heuristic keyword matching.
      return dependencyFiles.filter((file) => normalized.has(file));
    }
    return files;
  }

  private analyzeDependencyInstallation(
    contents: Map<string, { current: { sha: string; content: string }; old: { sha: string; content: string } | null }>,
  ) {
    const findings: string[] = [];
    const fixes: SourceFileFix[] = [];
    const packageJson = contents.get('package.json');
    const lockfile = contents.get('package-lock.json') ?? contents.get('npm-shrinkwrap.json');

    if (!packageJson?.old) {
      return { findings, fixes, rootCause: null, confidence: 'low' as const, exactFix: null };
    }

    let currentManifest: Record<string, any>;
    let previousManifest: Record<string, any>;
    try {
      currentManifest = JSON.parse(packageJson.current.content);
      previousManifest = JSON.parse(packageJson.old.content);
    } catch {
      return {
        findings: ['Dependency-installation failure detected, but package.json could not be parsed safely for source correlation.'],
        fixes,
        rootCause: null,
        confidence: 'low' as const,
        exactFix: null,
      };
    }

    const currentDeps = { ...(currentManifest.dependencies ?? {}), ...(currentManifest.devDependencies ?? {}), ...(currentManifest.optionalDependencies ?? {}) };
    const previousDeps = { ...(previousManifest.dependencies ?? {}), ...(previousManifest.devDependencies ?? {}), ...(previousManifest.optionalDependencies ?? {}) };
    const added = Object.keys(currentDeps).filter((name) => !(name in previousDeps));
    const platformPackages = added.filter((name) => /^@next\/swc-(darwin|win32|linux)-/i.test(name));

    if (!platformPackages.length) {
      return {
        findings: [
          'Dependency-installation failure detected, but no newly introduced platform-specific @next/swc package was found in the deployment-aware package.json diff.',
        ],
        fixes,
        rootCause: null,
        confidence: 'medium' as const,
        exactFix: null,
      };
    }

    const packageName = platformPackages[0];
    const manifestSection = ['dependencies', 'devDependencies', 'optionalDependencies'].find((section) => currentManifest[section]?.[packageName]);
    const version = currentManifest[manifestSection!][packageName];
    const lockContainsPackage = lockfile?.current.content.includes(packageName) ?? false;

    findings.push(
      `Dependency-domain finding: ${packageName}@${version} was introduced in package.json between the deployment-aware known-good revision and the failing revision.`,
    );
    if (lockContainsPackage) {
      findings.push(`The deployed npm lockfile also contains ${packageName}, confirming the platform-specific dependency entered the resolved dependency graph.`);
    }

    const isVercelLinuxIncompatible = /darwin|win32/i.test(packageName);
    const rootCause = isVercelLinuxIncompatible
      ? `The failing npm install is most likely caused by the newly introduced platform-specific dependency ${packageName}@${version}. The package targets ${/darwin/i.test(packageName) ? 'Darwin' : 'Windows'} rather than Vercel's Linux build environment.`
      : `The failing npm install is most likely caused by the newly introduced platform-specific dependency ${packageName}@${version}.`;

    const cleanedManifest = this.removeDependencyFromManifest(packageJson.current.content, packageName);
    if (cleanedManifest !== packageJson.current.content) {
      fixes.push({
        path: 'package.json',
        content: cleanedManifest,
        sha: packageJson.current.sha,
        message: `fix(jarvis): remove platform-specific ${packageName} dependency`,
      });
    }

    // Do not restore an entire historical lockfile: that can silently revert unrelated
    // dependency updates. The repair workflow should regenerate the lockfile after the
    // manifest edit and verify the resulting dependency graph before deployment.
    const exactFix = `Remove ${packageName} from package.json and regenerate package-lock.json with the supported dependency graph; do not pin a Darwin/Windows-specific SWC package for the Vercel Linux build.`;

    findings.push(`Exact remediation: ${exactFix}`);

    return {
      findings,
      fixes,
      rootCause,
      confidence: isVercelLinuxIncompatible ? ('high' as const) : ('medium' as const),
      exactFix,
    };
  }

  private removeDependencyFromManifest(content: string, packageName: string): string {
    const manifest = JSON.parse(content);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (manifest[section] && packageName in manifest[section]) delete manifest[section][packageName];
    }
    return JSON.stringify(manifest, null, 2) + '\n';
  }
}
