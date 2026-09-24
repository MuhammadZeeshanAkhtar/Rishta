/**
 * @nikahmate/domain — the shared vocabulary.
 *
 * Imported by the mobile app, the API, and later the admin panel and website.
 * It must stay free of platform dependencies: no React, no React Native, no
 * Fastify, no Supabase client. ESLint enforces this (eslint.config.mjs).
 *
 * Phase 1 covers identity and reference data only. Profile, preferences,
 * discovery, interests and conversations arrive with their phases.
 */

export * from './constants.js';
export * from './common.js';
export * from './account.js';
export * from './reference.js';
