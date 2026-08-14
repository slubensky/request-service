/**
 * Typed access to process environment.
 *
 * Secrets (database URL, Cognito client secret, session key) are injected at
 * runtime from AWS Secrets Manager via App Runner env references (see infra/).
 * Nothing sensitive is read from disk or embedded here -- these helpers only
 * read `process.env` and fail closed when a required value is absent.
 */

/** Returns the env value, treating empty strings as absent. */
export function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** Returns the env value or throws -- use for values a code path cannot run without. */
export function requireEnv(name: string): string {
  const value = getEnv(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
