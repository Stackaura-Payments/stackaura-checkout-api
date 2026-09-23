import { EngineeringSourceInspectionService } from './engineering-source-inspection.service';

describe('EngineeringSourceInspectionService', () => {
  const github = { getCommitSnapshot: jest.fn(), getFile: jest.fn() };
  const service = new EngineeringSourceInspectionService(github as any);

  function response(body: unknown, ok = true) {
    return {
      ok,
      status: ok ? 200 : 404,
      json: jest.fn().mockResolvedValue(body),
    } as unknown as Response;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    github.getCommitSnapshot.mockResolvedValue({
      sha: 'failed', parentSha: 'known-good', message: 'bad deploy', author: 'Stackaura',
      changedFiles: ['package.json', 'package-lock.json'],
      patches: [{ path: 'package.json', status: 'modified', patch: '+ @next/swc-darwin-arm64' }],
    });
    github.getFile.mockImplementation(async (_repo: string, path: string, ref?: string) => {
      const currentPackage = JSON.stringify({ devDependencies: { '@next/swc-darwin-arm64': '^16.1.6', '@tailwindcss/postcss': '^4' } }, null, 2);
      const previousPackage = JSON.stringify({ devDependencies: { '@tailwindcss/postcss': '^4' } }, null, 2);
      const currentLock = '{\n  "@next/swc-darwin-arm64": "16.1.6"\n}';
      const previousLock = '{\n  "lockfileVersion": 3\n}';
      if (path === 'package.json' && ref === 'failed') return { sha: 'pkg-current', content: currentPackage };
      if (path === 'package.json' && ref === 'known-good') return { sha: 'pkg-old', content: previousPackage };
      if (path === 'package-lock.json' && ref === 'failed') return { sha: 'lock-current', content: currentLock };
      if (path === 'package-lock.json' && ref === 'known-good') return { sha: 'lock-old', content: previousLock };
      throw new Error('Unexpected GitHub file request: ' + path + '@' + ref);
    });
  });

  it('identifies the platform-specific SWC dependency and generates exact file fixes', async () => {
    const currentPackage = JSON.stringify({
      devDependencies: {
        '@next/swc-darwin-arm64': '^16.1.6',
        '@tailwindcss/postcss': '^4',
      },
    }, null, 2);
    const previousPackage = JSON.stringify({
      devDependencies: {
        '@tailwindcss/postcss': '^4',
      },
    }, null, 2);
    const currentLock = '{\n  "@next/swc-darwin-arm64": "16.1.6"\n}';
    const previousLock = '{\n  "lockfileVersion": 3\n}';

    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/commits/failed')) {
        return response({ parents: [{ sha: 'known-good' }] });
      }
      if (url.includes('/contents/package.json?ref=failed')) {
        return response({ sha: 'pkg-current', content: Buffer.from(currentPackage).toString('base64') });
      }
      if (url.includes('/contents/package.json?ref=known-good')) {
        return response({ sha: 'pkg-old', content: Buffer.from(previousPackage).toString('base64') });
      }
      if (url.includes('/contents/package-lock.json?ref=failed')) {
        return response({ sha: 'lock-current', content: Buffer.from(currentLock).toString('base64') });
      }
      if (url.includes('/contents/package-lock.json?ref=known-good')) {
        return response({ sha: 'lock-old', content: Buffer.from(previousLock).toString('base64') });
      }
      throw new Error('Unexpected GitHub URL: ' + url);
    });

    const result = await service.inspect(
      'Stackaura-Payments/stackaura',
      'failed',
      ['package.json', 'package-lock.json'],
      undefined,
      'dependency-installation',
    );

    expect(result.previousKnownGoodCommit).toBe('known-good');
    expect(result.failureDomain).toBe('dependency-installation');
    expect(result.confidence).toBe('high');
    expect(result.rootCause).toMatch(/@next\/swc-darwin-arm64/);
    expect(result.exactFix).toMatch(/Remove @next\/swc-darwin-arm64/);
    expect(result.findings.some((finding) => /Dependency-domain finding/.test(finding))).toBe(true);
    expect(result.findings.some((finding) => /Source-change candidate/.test(finding))).toBe(false);
    expect(result.fixes).toHaveLength(1);
    expect(result.fixes[0].path).toBe('package.json');
    expect(result.fixes[0].content).not.toContain('@next/swc-darwin-arm64');
    expect(result.fileComparisons.find((file) => file.path === 'package-lock.json')?.changed).toBe(true);
  });
});
