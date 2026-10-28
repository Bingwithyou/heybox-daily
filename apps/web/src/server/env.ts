export interface Env {
  DB: D1Database;
  SITE_CONFIG?: KVNamespace;
  SPONSOR_ASSETS?: R2Bucket;
  SITE_URL: string;
  RUNNER_URL: string;
  BETTER_AUTH_SECRET: string;
  RUNNER_SERVICE_TOKEN: string;
  EXECUTOR?: Fetcher;
  EXECUTOR_ENABLED?: "true" | "false";
  DAILY_EXECUTOR?: "legacy" | "cloudflare";
  DEPLOYMENT_ENV?: "staging";
}
