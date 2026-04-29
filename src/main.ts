import 'dotenv/config';
import { Logger, RequestMethod, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { assertCredentialEncryptionPolicy } from './security/secrets';
import cookieParser = require('cookie-parser');

export function assertPayfastPostbackPolicy() {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  const verifyPostback =
    process.env.PAYFAST_VERIFY_POSTBACK?.trim().toLowerCase();

  if (nodeEnv === 'production' && verifyPostback === 'false') {
    throw new Error(
      'PAYFAST_VERIFY_POSTBACK=false is not allowed in production',
    );
  }
}

export function assertSessionSecretPolicy(
  env: NodeJS.ProcessEnv = process.env,
) {
  const sessionSecret = env.SESSION_SECRET?.trim();
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET is required');
  }
}

export function isSwaggerEnabled(env: NodeJS.ProcessEnv = process.env) {
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  const enabled = env.SWAGGER_ENABLED?.trim().toLowerCase() === 'true';
  return nodeEnv !== 'production' || enabled;
}

export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('checkout-api')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'ck_*',
        name: 'Authorization',
        in: 'header',
      },
      'bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.security = [{ bearer: [] }];
  SwaggerModule.setup('docs', app, document, {
    useGlobalPrefix: false,
    jsonDocumentUrl: '/docs-json',
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}

export const GLOBAL_PREFIX_EXCLUDES = [
  { path: 'payments/ozow/initiate', method: RequestMethod.POST },
  { path: 'payments/ozow/:reference/status', method: RequestMethod.GET },
  { path: 'webhooks/ozow', method: RequestMethod.POST },
  { path: 'webhooks/whatsapp', method: RequestMethod.GET },
  { path: 'webhooks/whatsapp', method: RequestMethod.POST },
  { path: 'shopify/health', method: RequestMethod.GET },
  { path: 'shopify/auth/token-exchange', method: RequestMethod.POST },
  { path: 'shopify/shop', method: RequestMethod.GET },
  { path: 'shopify/register-webhooks', method: RequestMethod.POST },
  { path: 'shopify/webhooks', method: RequestMethod.POST },
  { path: 'shopify/support-agent/widget-config', method: RequestMethod.GET },
  { path: 'shopify/support-agent/activation', method: RequestMethod.POST },
  { path: 'shopify/support-agent/chat', method: RequestMethod.POST },
];

export async function bootstrap() {
  assertPayfastPostbackPolicy();
  assertSessionSecretPolicy();
  assertCredentialEncryptionPolicy();
  const logger = new Logger('Bootstrap');

  // rawBody: true captures req.rawBody (Buffer) for signature verification
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(cookieParser());
  app.use(
    [
      '/shopify/support-agent/widget-config',
      '/shopify/support-agent/activation',
      '/shopify/support-agent/chat',
    ],
    (req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');

      if (req.method === 'OPTIONS') {
        res.status(204).send();
        return;
      }

      next();
    },
  );

  app.enableCors({
    origin: [
      'https://stackaura.co.za',
      'https://www.stackaura.co.za',
      'http://127.0.0.1:3000',
      'http://localhost:3000',
    ],
    credentials: true,
  });

  // All routes are under /v1 except provider-facing Ozow endpoints.
  app.setGlobalPrefix('v1', {
    exclude: GLOBAL_PREFIX_EXCLUDES,
  });
  if (isSwaggerEnabled()) {
    setupSwagger(app);
  }

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  logger.log(
    'Support routes enabled at /v1/support/conversations, /v1/support/conversations/:conversationId, /v1/support/chat, and /v1/support/conversations/:conversationId/escalate',
  );
  logger.log(
    'Shopify routes enabled at /shopify/health, /shopify/auth/token-exchange, /shopify/shop, /shopify/register-webhooks, /shopify/webhooks, /shopify/support-agent/widget-config, /shopify/support-agent/activation, and /shopify/support-agent/chat',
  );
  logger.log(`Checkout API listening on http://localhost:${port}`);
}

if (require.main === module) {
  void bootstrap();
}
