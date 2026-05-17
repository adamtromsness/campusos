import { SetMetadata } from '@nestjs/common';

/**
 * Cycle 32 Step 6 — Home Region Required.
 *
 * Apply to controller methods (or whole controllers) that MUST run
 * in the tenant's home region. The RegionMismatchInterceptor reads
 * this metadata; when set, a request whose tenant.homeRegion does
 * not match process.env.AWS_REGION is rejected with HTTP 421
 * Misdirected Request.
 *
 * Required on:
 *   - Cycle 30 DPO endpoints (SAR, erasure, breach) — GDPR data
 *     residency mandates that DPO operations execute in the home
 *     region.
 *   - Any future endpoint that touches PII at the storage layer.
 *
 * Not required for:
 *   - Read-only public discovery endpoints.
 *   - Platform Admin endpoints (already platform-scoped).
 */
export const HOME_REGION_REQUIRED_KEY = 'isHomeRegionRequired';
export const HomeRegionRequired = () => SetMetadata(HOME_REGION_REQUIRED_KEY, true);
