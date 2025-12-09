import type { OpenApiLogger } from "./types.ts";

/**
 * Default logger used when no custom logger is configured.
 *
 * - Emits to `console.error` / `console.warn`.
 * - Accepts an optional `meta` payload for structured context.
 * - Never throws.
 *
 * Consumers can override this behavior through `setOpenApiLogger()`.
 */
const defaultLogger: OpenApiLogger = {
  error: (message: string, meta?: unknown): void => {
    if (meta !== undefined) {
      console.error(message, meta);
    } else {
      console.error(message);
    }
  },
  warn: (message: string, meta?: unknown): void => {
    if (meta !== undefined) {
      console.warn(message, meta);
    } else {
      console.warn(message);
    }
  }
};

let currentLogger: OpenApiLogger = defaultLogger;

/**
 * Returns the currently active logger.
 *
 * This indirection allows the generator to consume logging consistently
 * without importing `console` directly and without coupling to a specific
 * logging implementation.
 */
export function getLogger(): OpenApiLogger {
  return currentLogger;
}

/**
 * Installs a custom logger.
 *
 * Requirements:
 * - must define `error` and `warn` as functions.
 *
 * Invalid or missing loggers fall back to the built-in logger.
 */
export function setOpenApiLogger(logger: null | OpenApiLogger | undefined): void {
  if (logger && typeof logger.error === 'function' && typeof logger.warn === 'function') {
    currentLogger = logger;
  } else {
    currentLogger = defaultLogger;
  }
}

/**
 * Produces a shortened, human-readable file path.
 *
 * Useful for error reporting when module paths are deeply nested. The
 * function keeps the final `segments` path parts and prefixes with an
 * ellipsis.
 *
 * Example:
 *   shortenFilePath('/src/routes/api/users/[id]/+server.ts', 3)
 *   → '…/users/[id]/+server.ts'
 */
export function shortenFilePath(path: string, segments = 3): string {
  const parts = path.split(/[/\\]/);
  if (parts.length <= segments) return path;
  const tail = parts.slice(-segments).join('/');
  return `…/${tail}`;
}
