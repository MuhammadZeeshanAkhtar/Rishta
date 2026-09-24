import * as Sentry from '@sentry/node';
import type { Config } from '../config';

/**
 * Error reporting.
 *
 * A crash reporter on a product like this sees personal data by accident:
 * request bodies, headers, query strings. The defaults are therefore tightened
 * rather than accepted — `sendDefaultPii` off, and a scrubbing pass before
 * anything leaves the process.
 */

let initialised = false;

export function initSentry(config: Config): void {
  if (!config.SENTRY_DSN) {
    // Absent in development, and that is fine. Silently doing nothing is the
    // correct behaviour; failing to start would be worse.
    return;
  }

  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,

    /** Never attach cookies, headers or user IP automatically. */
    sendDefaultPii: false,

    tracesSampleRate: config.NODE_ENV === 'production' ? 0.1 : 0,

    beforeSend(event) {
      return scrub(event);
    },

    beforeBreadcrumb(breadcrumb) {
      // Breadcrumbs record URLs, and a URL can carry an id that identifies a
      // real person. Keep the shape, drop the specifics.
      if (breadcrumb.data && typeof breadcrumb.data['url'] === 'string') {
        breadcrumb.data['url'] = maskUuids(breadcrumb.data['url']);
      }
      return breadcrumb;
    },
  });

  initialised = true;
}

/**
 * Removes credentials and identifiers from an event.
 *
 * Deliberately aggressive: a stack trace is worth having, a member's id in a
 * third-party dashboard is not.
 */
function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;

    if (event.request.headers) {
      for (const header of ['authorization', 'cookie', 'x-api-key']) {
        delete event.request.headers[header];
      }
    }

    if (typeof event.request.url === 'string') {
      event.request.url = maskUuids(event.request.url);
    }
    if (typeof event.request.query_string === 'string') {
      event.request.query_string = '[redacted]';
    }
  }

  // Keep a stable id for correlating reports; drop everything else about them.
  if (event.user) {
    const id = event.user.id;
    event.user = id === undefined ? {} : { id };
  }

  return event;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function maskUuids(value: string): string {
  return value.replace(UUID_PATTERN, ':id');
}

export function captureException(error: unknown): void {
  if (!initialised) return;
  Sentry.captureException(error);
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialised) return;
  await Sentry.flush(timeoutMs);
}
