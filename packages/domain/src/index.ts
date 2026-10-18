/**
 * @nikahmate/domain — the shared vocabulary.
 *
 * Imported by the mobile app, the API, and later the admin panel and website.
 * It must stay free of platform dependencies: no React, no React Native, no
 * Fastify, no Supabase client. ESLint enforces this (eslint.config.mjs).
 *
 * Phases 1-4 cover identity, reference data, profile, preferences and photos.
 * Phase 5 adds the deterministic compatibility engine, which lives here
 * because it is pure: no I/O, no clock, and nothing platform-specific.
 * Interests and conversations arrive with their phases.
 */

export * from './constants';
export * from './common';
export * from './account';
export * from './reference';
export * from './profile';
export * from './media';
export * from './compatibility';
export * from './discovery';
export * from './safety';
