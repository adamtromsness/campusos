// Cycle 31 Step 2 — OpenTelemetry must bootstrap BEFORE any
// instrumented module is required. The SDK monkey-patches the
// underlying http / pg / ioredis / kafkajs modules at require-time;
// any import above this line would skip auto-instrumentation.
import { bootstrapOpenTelemetry } from '@shared/observability/otel-bootstrap';
bootstrapOpenTelemetry();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
var cookieParser = require('cookie-parser');
import { AppModule } from './app.module';
import { StructuredLogger } from '@shared/observability/structured-logger';

async function bootstrap() {
  // Cycle 31 Step 1 — install the structured JSON logger before
  // NestFactory boot so the bootstrap log lines themselves are
  // structured. The logger is a no-arg constructor in dev; production
  // sets SERVICE_NAME via env to differentiate per-service log groups
  // when the monolith eventually splits per the extraction plan.
  var logger = new StructuredLogger();
  var app = await NestFactory.create(AppModule, { logger });

  // Global prefix for all API routes. /metrics is intentionally outside
  // the prefix so the Prometheus scraper can hit it without picking up
  // the /api/v1 namespace, matching the convention every Prometheus
  // exporter follows. Cycle 31 Step 3.
  app.setGlobalPrefix('api/v1', { exclude: ['/metrics'] });

  // Cookie parser for HttpOnly refresh tokens
  app.use(cookieParser());

  // Validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  });

  // Swagger
  var config = new DocumentBuilder()
    .setTitle('CampusOS API')
    .setDescription('The School Operating System — API Reference')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  var document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  var port = process.env.PORT || 4000;
  await app.listen(port);

  // Boot lines flow through the structured logger so CI / production
  // log aggregation sees a consistent JSON shape from the very first
  // line. The conventional Boot context name keeps these lines easy
  // to grep for during cold-start incident response.
  logger.log('CampusOS API running on http://localhost:' + port, 'Boot');
  logger.log('Swagger docs at http://localhost:' + port + '/api/docs', 'Boot');
  logger.log('Dev login: POST http://localhost:' + port + '/api/v1/auth/dev-login', 'Boot');
}

bootstrap();
