import { EngineeringSourceInspectionService } from './engineering-source-inspection.service';

describe('EngineeringSourceInspectionService', () => {
  const service = new EngineeringSourceInspectionService();

  function response(body: unknown, ok = true) {
    return {
      ok,
      status: ok ? 200 : 404,
      json: jest.fn().mockResolvedValue(body),
    } as unknown as Response;
  }

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.JARVIS_GITHUB_ALLOWED_OWNERS = 'Stackaura-Payments';
    jest.restoreAllMocks();
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
    );

    expect(result.previousKnownGoodCommit).toBe('known-good');
    expect(result.findings.some((finding) => /High-confidence source finding/.test(finding))).toBe(true);
    expect(result.fixes).toHaveLength(2);
    expect(result.fixes[0].path).toBe('package.json');
    expect(result.fixes[0].content).not.toContain('@next/swc-darwin-arm64');
    expect(result.fixes[1].path).toBe('package-lock.json');
    expect(result.fixes[1].content).toBe(previousLock);
  });
});
