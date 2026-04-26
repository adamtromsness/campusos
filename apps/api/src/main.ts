import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
var cookieParser = require('cookie-parser');
import { AppModule } from './app.module';

async function bootstrap() {
  var app = await NestFactory.create(AppModule);

  // Global prefix for all API routes
  app.setGlobalPrefix('api/v1');

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

  console.log('CampusOS API running on http://localhost:' + port);
  console.log('Swagger docs at http://localhost:' + port + '/api/docs');
  console.log('Dev login: POST http://localhost:' + port + '/api/v1/auth/dev-login');
}

bootstrap();
