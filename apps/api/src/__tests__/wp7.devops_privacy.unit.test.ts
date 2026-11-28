import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pseudonymizeIdentifier, sanitizeMetricsForExternalAi } from "../ai/triage.js";
import { buildDatabaseUrlFromPgEnv, env } from "../config/env.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(dirname, "../..");
const repoRoot = path.resolve(apiRoot, "../..");

describe("WP-7 supply chain, DevOps hardening, privacy & docs alignment", () => {
  it("URI-encodes special characters safely in buildDatabaseUrlFromPgEnv", () => {
    const uri = buildDatabaseUrlFromPgEnv({
      PGHOST: "postgres",
      PGPORT: "5432",
      PGUSER: "supermarket",
      PGPASSWORD: "p@ss:w#rd/%1?x=2",
      PGDATABASE: "supermarket_os",
    });
    expect(uri).toBeTruthy();
    const parsed = new URL(uri!);
    expect(decodeURIComponent(parsed.password)).toBe("p@ss:w#rd/%1?x=2");
    expect(parsed.hostname).toBe("postgres");
    expect(parsed.port).toBe("5432");
    expect(buildDatabaseUrlFromPgEnv({ PGUSER: "supermarket" })).toBeNull();
  });

  it("pins all GitHub Actions to commit SHAs, expands feat/** push CI, and ships dependabot config", () => {
    const ciYml = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const secYml = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "security.yml"), "utf8");

    expect(ciYml).toContain('"feat/**"');
    expect(secYml).toContain('"feat/**"');
    expect(ciYml).toContain("postgres:16-alpine@sha256:");
    expect(ciYml).toContain("--frozen pytest -v");

    for (const yml of [ciYml, secYml]) {
      const usesMatches = Array.from(yml.matchAll(/uses:\s*([^\s#]+)/g)).map((m) => m[1]);
      expect(usesMatches.length).toBeGreaterThan(0);
      for (const ref of usesMatches) {
        expect(ref).toMatch(/@[0-9a-f]{40}$/);
      }
    }

    const dependabot = fs.readFileSync(path.join(repoRoot, ".github", "dependabot.yml"), "utf8");
    for (const eco of ['"github-actions"', '"docker"', '"npm"', '"uv"', '"cargo"']) {
      expect(dependabot).toContain(eco);
    }
  });

  it("pins container base digests, enables container read_only + discrete PG*, and bundles migrations", () => {
    const dfApi = fs.readFileSync(path.join(repoRoot, "infra", "Dockerfile.api"), "utf8");
    const dfWeb = fs.readFileSync(path.join(repoRoot, "infra", "Dockerfile.web"), "utf8");
    const dfAnalytics = fs.readFileSync(path.join(repoRoot, "infra", "Dockerfile.analytics"), "utf8");
    expect(dfApi).toContain("node:22-alpine@sha256:");
    expect(dfApi).toContain("./apps/api/drizzle");
    expect(dfWeb).toContain("nginxinc/nginx-unprivileged:1.27-alpine@sha256:");
    expect(dfAnalytics).toContain("python:3.12-slim@sha256:");
    expect(dfAnalytics).toContain("ghcr.io/astral-sh/uv:0.7.12@sha256:");

    const prodCompose = fs.readFileSync(path.join(repoRoot, "infra", "docker-compose.prod.yml"), "utf8");
    expect(prodCompose).toContain("postgres:16-alpine@sha256:");
    expect(prodCompose).toContain("read_only: true");
    expect(prodCompose).toContain("PGPASSWORD:");
    expect(prodCompose).not.toMatch(/postgres:\/\/[^:\n]+:\$\{POSTGRES_PASSWORD\}/);
  });

  it("consolidates Nginx/Fastify security headers, makes HSTS TLS-conditional, and caches /fonts/", () => {
    const nginxConf = fs.readFileSync(path.join(repoRoot, "infra", "nginx.conf"), "utf8");
    const nginxSec = fs.readFileSync(path.join(repoRoot, "infra", "nginx-security-headers.conf"), "utf8");
    expect(nginxConf).toContain("$smos_hsts_header");
    expect(nginxConf).toContain("proxy_hide_header Content-Security-Policy");
    expect(nginxConf).toContain("location /fonts/");
    expect(nginxSec).toContain("$smos_hsts_header");
    expect(nginxSec).not.toContain('"max-age=31536000; includeSubDomains"');
  });

  it("uses Windows-portable rmSync build scripts and removes orphaned turbo/duplicate setup files", () => {
    const apiPkg = fs.readFileSync(path.join(repoRoot, "apps", "api", "package.json"), "utf8");
    const sharedPkg = fs.readFileSync(path.join(repoRoot, "packages", "shared", "package.json"), "utf8");
    expect(apiPkg).not.toContain("rm -rf dist");
    expect(sharedPkg).not.toContain("rm -rf dist");
    expect(apiPkg).toContain("rmSync('dist'");
    expect(sharedPkg).toContain("rmSync('dist'");
    expect(apiPkg).toContain("db:migrate:prod");

    expect(fs.existsSync(path.join(repoRoot, "turbo.json"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "setup-windows.ps1"))).toBe(false);
    const setupPs = fs.readFileSync(path.join(repoRoot, "scripts", "setup-windows.ps1"), "utf8");
    expect(setupPs).not.toContain("C:\\Users\\Reinh");
    expect(setupPs).toContain("$PSScriptRoot");
    expect(setupPs).toContain("db:migrate");
    expect(setupPs).not.toContain("db:push");
  });

  it("hardens DR backup scripts, exposes privacy erasure/retention & PII pseudonymization, and documents all env vars", () => {
    const verifySh = fs.readFileSync(path.join(repoRoot, "scripts", "db-backup-verify.sh"), "utf8");
    expect(verifySh).toContain("umask 077");
    expect(verifySh).toContain("mktemp -d");
    expect(verifySh).not.toContain('test "$view_cnt" -ge 3000');

    expect(fs.existsSync(path.join(repoRoot, "scripts", "db-backup.sh"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "docs", "OPERATIONS_RUNBOOK.md"))).toBe(true);

    expect(env.aiRedactStaffPii).toBe(true);
    const pseudoA = pseudonymizeIdentifier("Staff", "Jordan Brooks");
    const pseudoB = pseudonymizeIdentifier("Staff", "Jordan Brooks");
    expect(pseudoA).toBe(pseudoB);
    expect(pseudoA).not.toContain("Jordan");

    const sanitized = sanitizeMetricsForExternalAi(
      { cashierName: "Jordan Brooks", phone: "+855123456", voidRatePct: 5.5 },
      true
    );
    expect(sanitized.cashierName).toBe(pseudoA);
    expect(sanitized.phone).toBe("[REDACTED]");
    expect(sanitized.voidRatePct).toBe(5.5);

    const adminSrc = fs.readFileSync(path.join(apiRoot, "src", "routes", "admin.ts"), "utf8");
    expect(adminSrc).toContain("/api/admin/customers/:id/anonymize");
    expect(adminSrc).toContain("/api/admin/retention/purge");

    const appWebSrc = fs.readFileSync(path.join(repoRoot, "apps", "web", "src", "App.tsx"), "utf8");
    expect(appWebSrc).toContain("clearPosCache()");
    expect(appWebSrc).toContain("clearCfdState()");

    const envExample = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    for (const key of [
      "DATABASE_URL",
      "DATABASE_URL_TEST",
      "PGHOST",
      "PGPORT",
      "PGUSER",
      "PGPASSWORD",
      "PGDATABASE",
      "AUTH_SECRET",
      "AUTH_SECRET_PREVIOUS",
      "PAYMENT_WEBHOOK_SECRET",
      "ANALYTICS_WORKER_TOKEN",
      "ANALYTICS_STATEMENT_TIMEOUT_MS",
      "ANALYTICS_LOCK_TIMEOUT_MS",
      "GEMINI_STORE_INTERACTIONS",
      "AI_REDACT_STAFF_PII",
      "AI_MAX_PROMO_DISCOUNT_BP",
      "AI_ACTION_TTL_HOURS",
      "POS_MAX_BACKDATE_HOURS",
      "POS_MAX_FUTURE_SKEW_SEC",
      "STORE_TIMEZONE",
    ]) {
      expect(envExample).toContain(key);
    }

    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    expect(readme).not.toContain("Polars");
    expect(readme).not.toContain("pnpm db:push");
    expect(readme).toContain("pnpm db:migrate");
    expect(readme).toContain("docs/OPERATIONS_RUNBOOK.md");

    const escposRs = fs.readFileSync(
      path.join(repoRoot, "apps", "pos", "src-tauri", "src", "escpos.rs"),
      "utf8"
    );
    expect(escposRs).toContain("SELECT_CODEPAGE_PC858");
    expect(escposRs).toContain("normalize_escpos_text");
    expect(escposRs).toContain("truncate_display_width");

    const bootstrapSrc = fs.readFileSync(path.join(apiRoot, "src", "db", "bootstrapProd.ts"), "utf8");
    expect(bootstrapSrc).toContain('endsWith("/bootstrapProd.js")');
    expect(bootstrapSrc).toContain('endsWith("/bootstrapProd.ts")');

    const pwConfig = fs.readFileSync(path.join(repoRoot, "playwright.config.ts"), "utf8");
    expect(pwConfig).toContain("DATABASE_URL:");

    const prodTemplate = fs.readFileSync(path.join(repoRoot, ".env.production.template"), "utf8");
    expect(prodTemplate).toContain("NODE_ENV=production");
    expect(prodTemplate).toContain("POSTGRES_PASSWORD=<GENERATE_");
    expect(prodTemplate).toContain("AUTH_SECRET=<GENERATE_");
    expect(prodTemplate).toContain("ANALYTICS_WORKER_TOKEN=<GENERATE_");
    expect(prodTemplate).toContain("PAYMENT_WEBHOOK_SECRET=<GENERATE_");
    expect(prodTemplate).toContain("ENABLE_SANDBOX_PAYMENT_SIMULATION=false");
    expect(prodTemplate).toContain("VITE_ENABLE_DEMO_LOGIN=false");
    expect(prodTemplate).not.toContain("supermarket_dev_password");
  });
});
