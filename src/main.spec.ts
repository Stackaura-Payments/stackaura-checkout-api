import { RequestMethod } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import {
  GLOBAL_PREFIX_EXCLUDES,
  assertSessionSecretPolicy,
  isSwaggerEnabled,
  setupSwagger,
} from './main';

describe('main swagger bootstrap', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('enables Swagger outside production by default', () => {
    expect(isSwaggerEnabled({ NODE_ENV: 'development' })).toBe(true);
  });

  it('disables Swagger in production unless explicitly enabled', () => {
    expect(isSwaggerEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(
      isSwaggerEnabled({
        NODE_ENV: 'production',
        SWAGGER_ENABLED: 'true',
      }),
    ).toBe(true);
  });

  it('requires SESSION_SECRET for production bootstrapping', () => {
    expect(() => assertSessionSecretPolicy({} as NodeJS.ProcessEnv)).toThrow(
      'SESSION_SECRET is required',
    );
    expect(() =>
      assertSessionSecretPolicy({
        SESSION_SECRET: 'stackaura-prod-session-secret',
      }),
    ).not.toThrow();
  });

  it('excludes WhatsApp webhook verification and events from the /v1 prefix', () => {
    expect(GLOBAL_PREFIX_EXCLUDES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'webhooks/whatsapp',
          method: RequestMethod.GET,
        }),
        expect.objectContaining({
          path: 'webhooks/whatsapp',
          method: RequestMethod.POST,
        }),
      ]),
    );
  });

  it('setupSwagger does not throw and registers docs endpoints', () => {
    const createDocumentSpy = jest
      .spyOn(SwaggerModule, 'createDocument')
      .mockReturnValue({ openapi: '3.0.0' } as never);
    const setupSpy = jest
      .spyOn(SwaggerModule, 'setup')
      .mockImplementation(() => undefined as never);

    const app = {} as never;
    expect(() => setupSwagger(app)).not.toThrow();
    expect(createDocumentSpy).toHaveBeenCalledWith(app, expect.any(Object));
    expect(setupSpy).toHaveBeenCalledWith(
      'docs',
      app,
      expect.any(Object),
      expect.objectContaining({
        jsonDocumentUrl: '/docs-json',
      }),
    );
  });
});
