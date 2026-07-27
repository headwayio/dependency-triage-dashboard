#!/usr/bin/env node
"use strict";
// Fixture-backed mock of the Dependency Dashboard API for safe visual work.
// Serves the REAL public/ files from the repo (live, so edits show on reload)
// but stubs every /api/* endpoint — no gh calls, no jobs, no pollers.

const http = require("http");
const fs = require("fs");
const path = require("path");

const REPO = require("path").join(__dirname, "..");
const PORT = Number(process.env.PORT || 8899);

const days = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ---- alert model fixtures ----------------------------------------------------
const pkg = (severity, ecosystem, name, patched, ghsa, manifest, ann) => ({
  severity, ecosystem, pkg: name, patched, ghsa,
  url: `https://github.com/advisories/${ghsa}`, manifest: manifest || (ecosystem === "rubygems" ? "Gemfile.lock" : "package-lock.json"),
  ...(ann || {}), // optional installed/target/bump/majorRequired (the real model annotates these)
});

const repos = [
  {
    name: "acme-rails-app", nameWithOwner: "acme-corp/acme-rails-app", url: "https://github.com/acme-corp/acme-rails-app",
    archived: false, pending: false, classification: "maintained",
    counts: { critical: 2, high: 5, medium: 3, low: 1, total: 11 },
    ecosystems: { rubygems: 8, npm: 3 },
    packages: [
      pkg("critical", "rubygems", "rails", "7.1.5.2", "GHSA-x7j2-9q4r-aaaa"),
      pkg("critical", "rubygems", "nokogiri", "1.18.3", "GHSA-pp22-8a3c-bbbb"),
      pkg("high", "rubygems", "rack", "3.1.12", "GHSA-7g2v-jj9q-cccc"),
      pkg("high", "rubygems", "devise", "5.0.4", "GHSA-1m2n-3o4p-dddd", null, { installed: "4.9.4", target: "5.0.4", bump: "major", majorRequired: true }),
      pkg("high", "npm", "axios", "2.0.0", "GHSA-jr5f-v2jv-eeee", null, { installed: "1.8.2", target: "2.0.0", bump: "major", majorRequired: true }),
      pkg("high", "npm", "lodash", "4.17.23", "GHSA-29mw-wpgm-ffff"),
      pkg("high", "rubygems", "globalid", "1.2.1", "GHSA-23c2-9w3e-gggg"),
      pkg("medium", "rubygems", "puma", "6.4.3", "GHSA-9hf4-67fc-hhhh"),
      pkg("medium", "npm", "postcss", "8.4.49", "GHSA-7fh5-64p2-iiii"),
      pkg("medium", "rubygems", "loofah", "2.23.1", "GHSA-3hue-9x9q-jjjj"),
      pkg("low", "rubygems", "rexml", "3.3.9", "GHSA-vg3r-rm7w-kkkk"),
    ],
    language: "Ruby", visibility: "PRIVATE", defaultBranch: "main", pushedAt: days(4),
    published: null, dependents: [], dependsOnOrg: ["acme-core-gem"],
    contact: { name: "Casey Lee", email: "casey@example.com" },
    notifiedAt: null, newAdvisoryCount: 0, disposition: null, openPRs: [],
    blocked: [
      { ecosystem: "rubygems", pkg: "devise", resolved: "4.9.4", floor: "5.0.4", reason: "Capped below the patched floor by a Gemfile or parent-gem constraint — bump the blocking constraint (or parent gem) to admit the patch." },
      { ecosystem: "npm", pkg: "minimatch", resolved: "3.0.5", floor: "3.1.4", reason: "Still below the patched floor after a manifest override — a parent dependency's range pins it; bump the parent." },
    ],
    engagement: { at: days(30), kind: "engagement", from: "untriaged", to: "maintained", note: "Active SOW through Q4." },
  },
  {
    name: "acme-core-gem", nameWithOwner: "acme-corp/acme-core-gem", url: "https://github.com/acme-corp/acme-core-gem",
    archived: false, pending: false, classification: "maintained",
    counts: { critical: 0, high: 3, medium: 0, low: 0, total: 3 },
    ecosystems: { rubygems: 3 },
    packages: [
      pkg("high", "rubygems", "carrierwave", "2.2.7", "GHSA-aaaa-1111-mmmm", "acme-core.gemspec"),
      pkg("high", "rubygems", "carrierwave", "2.2.6", "GHSA-bbbb-2222-nnnn", "acme-core.gemspec"),
      pkg("high", "rubygems", "carrierwave", "2.2.5", "GHSA-cccc-3333-oooo", "acme-core.gemspec"),
    ],
    language: "Ruby", visibility: "PRIVATE", defaultBranch: "main", pushedAt: days(12),
    published: { registry: "rubygems" }, dependents: ["acme-rails-app", "acme-api"], dependsOnOrg: [],
    contact: null, notifiedAt: null, newAdvisoryCount: 0,
    disposition: {
      state: "blocked", ok: [],
      blocked: [
        "carrierwave resolves to 1.3.4 but the advisory needs ≥ 2.2.7",
        "carrierwave resolves to 1.3.4 but the advisory needs ≥ 2.2.6",
      ],
      at: days(2),
    },
    openPRs: [], engagement: null,
  },
  {
    name: "acme-api", nameWithOwner: "acme-corp/acme-api", url: "https://github.com/acme-corp/acme-api",
    archived: false, pending: false, classification: "maintained",
    counts: { critical: 1, high: 2, medium: 4, low: 2, total: 9 },
    ecosystems: { npm: 9 },
    packages: [
      pkg("critical", "npm", "jsonwebtoken", "9.0.2", "GHSA-dddd-4444-pppp"),
      pkg("high", "npm", "express", "4.21.2", "GHSA-eeee-5555-qqqq"),
      pkg("high", "npm", "ws", "8.18.0", "GHSA-ffff-6666-rrrr"),
      pkg("medium", "npm", "cookie", "0.7.2", "GHSA-gggg-7777-ssss"),
      pkg("medium", "npm", "send", "0.19.1", "GHSA-hhhh-8888-tttt"),
      pkg("medium", "npm", "serve-static", "1.16.2", "GHSA-iiii-9999-uuuu"),
      pkg("medium", "npm", "path-to-regexp", "0.1.12", "GHSA-jjjj-0000-vvvv"),
      pkg("low", "npm", "micromatch", "4.0.8", "GHSA-kkkk-1212-wwww"),
      pkg("low", "npm", "braces", "3.0.3", "GHSA-llll-3434-xxxx"),
    ],
    language: "TypeScript", visibility: "PRIVATE", defaultBranch: "main", pushedAt: days(9),
    published: null, dependents: [], dependsOnOrg: [],
    contact: { name: "Dana Client", email: "dana@acme.com" },
    notifiedAt: null, newAdvisoryCount: 0, disposition: null, openPRs: [], engagement: null,
  },
  {
    name: "legacy-billing", nameWithOwner: "acme-corp/legacy-billing", url: "https://github.com/acme-corp/legacy-billing",
    archived: false, pending: false, classification: null,
    counts: { critical: 1, high: 0, medium: 2, low: 0, total: 3 },
    ecosystems: { rubygems: 3 },
    packages: [
      pkg("critical", "rubygems", "paperclip", null, "GHSA-mmmm-5656-yyyy"),
      pkg("medium", "rubygems", "sprockets", "4.2.1", "GHSA-nnnn-7878-zzzz"),
      pkg("medium", "rubygems", "tzinfo", "2.0.6", "GHSA-oooo-9090-aaab"),
    ],
    language: "Ruby", visibility: "PRIVATE", defaultBranch: "master", pushedAt: days(420),
    published: null, dependents: [], dependsOnOrg: [],
    contact: null, notifiedAt: null, newAdvisoryCount: 0, disposition: null, openPRs: [], engagement: null,
  },
  {
    name: "widget-factory", nameWithOwner: "acme-corp/widget-factory", url: "https://github.com/acme-corp/widget-factory",
    archived: false, pending: false, classification: null,
    counts: { critical: 0, high: 1, medium: 1, low: 3, total: 5 },
    ecosystems: { npm: 5 },
    packages: [
      pkg("high", "npm", "next", "14.2.21", "GHSA-pppp-1313-bbac"),
      pkg("medium", "npm", "nanoid", "5.0.9", "GHSA-qqqq-2424-ccad"),
      pkg("low", "npm", "semver", "7.6.3", "GHSA-rrrr-3535-ddae"),
      pkg("low", "npm", "tar", "7.4.3", "GHSA-ssss-4646-eeaf"),
      pkg("low", "npm", "glob-parent", "6.0.2", "GHSA-tttt-5757-ffag"),
    ],
    language: "JavaScript", visibility: "PUBLIC", defaultBranch: "main", pushedAt: days(60),
    published: { registry: "npm" }, dependents: [], dependsOnOrg: [],
    contact: null, notifiedAt: null, newAdvisoryCount: 0, disposition: null, openPRs: [], engagement: null,
  },
  {
    name: "acme-frontend", nameWithOwner: "acme-corp/acme-frontend", url: "https://github.com/acme-corp/acme-frontend",
    archived: false, pending: true, classification: "maintained",
    counts: { critical: 0, high: 4, medium: 2, low: 0, total: 6 },
    ecosystems: { npm: 6 },
    packages: [
      pkg("high", "npm", "react-router", "6.28.1", "GHSA-uuuu-6868-ggah"),
      pkg("high", "npm", "vite", "5.4.12", "GHSA-vvvv-7979-hhai"),
      pkg("high", "npm", "dompurify", "3.2.4", "GHSA-wwww-8080-iiaj"),
      pkg("high", "npm", "katex", "0.16.21", "GHSA-xxxx-9191-jjak"),
      pkg("medium", "npm", "esbuild", "0.25.0", "GHSA-yyyy-0202-kkal"),
      pkg("medium", "npm", "rollup", "4.22.4", "GHSA-zzzz-1313-llam"),
    ],
    language: "TypeScript", visibility: "PRIVATE", defaultBranch: "main", pushedAt: days(1),
    published: null, dependents: [], dependsOnOrg: [],
    contact: { name: "Casey Lee", email: "casey@example.com" },
    notifiedAt: null, newAdvisoryCount: 0, disposition: null,
    openPRs: [{ number: 142, url: "https://github.com/acme-corp/acme-frontend/pull/142", draft: true, reviewDecision: null, reviewers: ["caseylee"] }],
    engagement: null,
  },
  {
    name: "data-pipeline", nameWithOwner: "acme-corp/data-pipeline", url: "https://github.com/acme-corp/data-pipeline",
    archived: false, pending: true, classification: "maintained",
    counts: { critical: 1, high: 1, medium: 0, low: 0, total: 2 },
    ecosystems: { pip: 2 },
    packages: [
      pkg("critical", "pip", "cryptography", "44.0.1", "GHSA-abab-1414-mman", "requirements.txt"),
      pkg("high", "pip", "jinja2", "3.1.5", "GHSA-cdcd-2525-nnao", "requirements.txt"),
    ],
    language: "Python", visibility: "PRIVATE", defaultBranch: "main", pushedAt: days(3),
    published: null, dependents: [], dependsOnOrg: [],
    contact: null, notifiedAt: null, newAdvisoryCount: 0, disposition: null,
    openPRs: [{ number: 57, url: "https://github.com/acme-corp/data-pipeline/pull/57", draft: false, reviewDecision: "APPROVED", reviewers: [] }],
    engagement: null,
  },
  {
    name: "checkout-api", nameWithOwner: "acme-corp/checkout-api", url: "https://github.com/acme-corp/checkout-api",
    archived: false, pending: true, classification: "maintained",
    counts: { critical: 0, high: 1, medium: 1, low: 0, total: 2 },
    ecosystems: { rubygems: 2 },
    packages: [
      pkg("high", "rubygems", "rack", "3.1.8", "GHSA-efef-3636-ooap"),
      pkg("medium", "rubygems", "nokogiri", "1.18.2", "GHSA-ghgh-4747-ppaq"),
    ],
    language: "Ruby", visibility: "PRIVATE", defaultBranch: "main", pushedAt: days(2),
    published: null, dependents: [], dependsOnOrg: [],
    contact: null, notifiedAt: null, newAdvisoryCount: 0, disposition: null,
    // CI green, but no approval yet → lands in the "Passing PR" tab awaiting review.
    openPRs: [{ number: 89, url: "https://github.com/acme-corp/checkout-api/pull/89", draft: false, reviewDecision: null, reviewers: ["caseylee"] }],
    reviewerOptions: [
      { handle: "caseylee", display: "caseylee", isTeam: false },
      { handle: "jordanp", display: "jordanp", isTeam: false },
      { handle: "acme-corp/platform", display: "platform", isTeam: true },
    ],
    engagement: null,
  },
  {
    name: "internal-tools-gem", nameWithOwner: "acme-corp/internal-tools-gem", url: "https://github.com/acme-corp/internal-tools-gem",
    archived: false, pending: false, classification: "maintained",
    counts: { critical: 0, high: 2, medium: 1, low: 0, total: 3 },
    ecosystems: { rubygems: 3 },
    packages: [
      pkg("high", "rubygems", "rack", "3.1.12", "GHSA-efef-3636-ooap", "internal-tools.gemspec"),
      pkg("high", "rubygems", "rails-html-sanitizer", "1.6.1", "GHSA-ghgh-4747-ppaq", "internal-tools.gemspec"),
      pkg("medium", "rubygems", "actionpack", "7.1.5.1", "GHSA-ijij-5858-qqar", "internal-tools.gemspec"),
    ],
    language: "Ruby", visibility: "PRIVATE", defaultBranch: "main", pushedAt: days(21),
    published: { registry: "rubygems" }, dependents: ["acme-rails-app"], dependsOnOrg: [],
    contact: null, notifiedAt: null, newAdvisoryCount: 0,
    disposition: { state: "covered", ok: ["rack ≥ 3.1.12", "rails-html-sanitizer ≥ 1.6.1", "actionpack ≥ 7.1.5.1"], blocked: [], at: days(5) },
    openPRs: [], engagement: null,
  },
  {
    name: "client-site-alpha", nameWithOwner: "acme-corp/client-site-alpha", url: "https://github.com/acme-corp/client-site-alpha",
    archived: false, pending: false, classification: "monitored",
    counts: { critical: 0, high: 2, medium: 3, low: 1, total: 6 },
    ecosystems: { rubygems: 4, npm: 2 },
    packages: [
      pkg("high", "rubygems", "rails", "7.0.8.7", "GHSA-klkl-6969-rras"),
      pkg("high", "npm", "webpack", "5.94.0", "GHSA-mnmn-7070-ssat"),
      pkg("medium", "rubygems", "puma", "6.4.3", "GHSA-opop-8181-ttau"),
      pkg("medium", "rubygems", "rack", "3.1.12", "GHSA-qrqr-9292-uuav"),
      pkg("medium", "npm", "babel-traverse", "7.23.2", "GHSA-stst-0303-vvaw"),
      pkg("low", "rubygems", "rexml", "3.3.9", "GHSA-uvuv-1414-wwax"),
    ],
    language: "Ruby", visibility: "PRIVATE", defaultBranch: "main", pushedAt: days(200),
    published: null, dependents: [], dependsOnOrg: [],
    contact: { name: "Pat Owner", email: "pat@alphasite.com" },
    notifiedAt: null, newAdvisoryCount: 0, disposition: null, openPRs: [],
    engagement: { at: days(90), kind: "engagement", from: "maintained", to: "monitored", note: "SOW ended; client self-manages.", sowEndDate: "2026-03-15" },
  },
  {
    name: "client-site-beta", nameWithOwner: "acme-corp/client-site-beta", url: "https://github.com/acme-corp/client-site-beta",
    archived: false, pending: false, classification: "monitored",
    counts: { critical: 1, high: 1, medium: 0, low: 0, total: 2 },
    ecosystems: { npm: 2 },
    packages: [
      pkg("critical", "npm", "next", "14.2.21", "GHSA-wxwx-2525-xxay"),
      pkg("high", "npm", "axios", "1.8.2", "GHSA-yzyz-3636-yyaz"),
    ],
    language: "TypeScript", visibility: "PRIVATE", defaultBranch: "main", pushedAt: days(310),
    published: null, dependents: [], dependsOnOrg: [],
    contact: { name: "Sam Beta", email: "sam@betasite.com" },
    notifiedAt: days(45), newAdvisoryCount: 2, disposition: null, openPRs: [], engagement: null,
  },
  {
    name: "client-site-gamma", nameWithOwner: "acme-corp/client-site-gamma", url: "https://github.com/acme-corp/client-site-gamma",
    archived: false, pending: false, classification: "monitored",
    counts: { critical: 0, high: 1, medium: 2, low: 0, total: 3 },
    ecosystems: { rubygems: 3 },
    packages: [
      pkg("high", "rubygems", "devise", "4.9.4", "GHSA-abcd-4747-zzba"),
      pkg("medium", "rubygems", "rack", "3.1.12", "GHSA-efgh-5858-aabb"),
      pkg("medium", "rubygems", "nokogiri", "1.18.3", "GHSA-ijkl-6969-bbcc"),
    ],
    language: "Ruby", visibility: "PRIVATE", defaultBranch: "main", pushedAt: days(280),
    published: null, dependents: [], dependsOnOrg: [],
    contact: { name: "Gail Gamma", email: "gail@gammasite.com" },
    notifiedAt: days(6), newAdvisoryCount: 0, disposition: null, openPRs: [], engagement: null,
  },
  {
    name: "old-experiment", nameWithOwner: "acme-corp/old-experiment", url: "https://github.com/acme-corp/old-experiment",
    archived: false, pending: false, classification: "ignored",
    counts: { critical: 0, high: 0, medium: 1, low: 2, total: 3 },
    ecosystems: { npm: 3 },
    packages: [
      pkg("medium", "npm", "minimist", "1.2.8", "GHSA-mnop-7070-ccdd"),
      pkg("low", "npm", "ms", "2.1.3", "GHSA-qrst-8181-ddee"),
      pkg("low", "npm", "debug", "4.3.7", "GHSA-uvwx-9292-eeff"),
    ],
    language: "JavaScript", visibility: "PRIVATE", defaultBranch: "main", pushedAt: days(800),
    published: null, dependents: [], dependsOnOrg: [],
    contact: null, notifiedAt: null, newAdvisoryCount: 0, disposition: null, openPRs: [], engagement: null,
  },
];

const model = {
  org: "acme-corp", generatedAt: new Date().toISOString(), repos,
  // Fallback roster for a repo nobody has reviewed yet (reviewerOptions empty).
  orgMembers: ["ana-dev", "caseylee", "jordanp", "morgan-ops", "sam-qa"].map((h) => ({ handle: h, display: h, isTeam: false })),
};

// ---- side-channel fixtures ---------------------------------------------------
const eolStatus = {
  "acme-api": [
    { id: "node", pinned: "16.20.2", eolDate: "2023-09-11", target: { version: "22", lts: true } },
  ],
};

const protection = {
  "acme-rails-app": { protected: false },
  "acme-core-gem": { protected: true, via: "ruleset" },
  "acme-api": { protected: true, via: "ruleset" },
  "acme-frontend": { protected: false },
  "data-pipeline": { protected: true, via: "ruleset" },
  "internal-tools-gem": { protected: true, via: "ruleset" },
};

const ciStatuses = {
  "acme-frontend": { state: "failing", failing: ["rspec", "eslint"], headSha: "abc123", attempts: 1, capped: false, fixing: false, at: Date.now() },
  "data-pipeline": { state: "passing", failing: [], headSha: "def456", attempts: 0, capped: false, fixing: false, at: Date.now() },
  "checkout-api": { state: "passing", failing: [], headSha: "ghi789", attempts: 0, capped: false, fixing: false, at: Date.now() },
};
const prMeta = {
  "acme-frontend": [{ number: 142, draft: true, reviewDecision: null, reviewers: ["caseylee"] }],
  "data-pipeline": [{ number: 57, draft: false, reviewDecision: "APPROVED", reviewers: [] }],
  "checkout-api": [{ number: 89, draft: false, reviewDecision: null, reviewers: ["caseylee"] }],
};

const compRepo = (name, opts = {}) => ({
  name, url: `https://github.com/acme-corp/${name}`, defaultBranch: "main",
  pushedAt: opts.pushedAt || days(30), visibility: opts.visibility || "PRIVATE",
  scope: opts.scope || "out", scopeDerived: opts.scopeDerived || opts.scope || "out",
  scopeOverride: opts.scopeOverride || null,
  classification: opts.classification || "untriaged",
  protectionScope: !!opts.protectionScope, protected: "protected" in opts ? opts.protected : null,
  isGem: !!opts.isGem, published: opts.published || null, dependents: opts.dependents || [],
  engagement: opts.engagement || null,
  dependabot: opts.dependabot || { state: "ok", blockedBy: [], stale: [] },
});

const complianceRepos = [
  compRepo("acme-rails-app", { scope: "in", classification: "maintained", protectionScope: true, protected: false, pushedAt: days(4), dependents: [] }),
  compRepo("acme-core-gem", { scope: "in", classification: "maintained", protectionScope: true, protected: true, isGem: true, published: { registry: "rubygems" }, dependents: ["acme-rails-app", "acme-api"], pushedAt: days(12) }),
  compRepo("acme-api", { scope: "in", classification: "maintained", protectionScope: true, protected: true, pushedAt: days(9), dependabot: { state: "blocked", blockedBy: ["acme-private-gem"] } }),
  compRepo("acme-frontend", { scope: "in", classification: "maintained", protectionScope: true, protected: false, pushedAt: days(1) }),
  compRepo("data-pipeline", { scope: "in", classification: "maintained", protectionScope: true, protected: true, pushedAt: days(3), dependabot: { state: "blocked", blockedBy: ["acme-private-gem"] } }),
  compRepo("internal-tools-gem", { scope: "out", scopeDerived: "in", scopeOverride: { scope: "out", reason: "Internal gem — outside the customer boundary.", at: days(20) }, classification: "maintained", isGem: true, published: { registry: "rubygems" }, dependents: ["acme-rails-app"], pushedAt: days(21) }),
  compRepo("client-site-alpha", { classification: "monitored", pushedAt: days(200), engagement: { at: days(90), kind: "engagement", from: "maintained", to: "monitored", note: "SOW ended; client self-manages.", sowEndDate: "2026-03-15" } }),
  compRepo("client-site-beta", { classification: "monitored", pushedAt: days(310), dependabot: { state: "stale", blockedBy: [], stale: [
    { ecosystem: "mix", label: "hex", interval: "weekly", lastRunAt: days(105), ageDays: 105, staleAfterDays: 15 },
    { ecosystem: "npm", label: "npm_and_yarn", interval: "weekly", lastRunAt: null, ageDays: null, staleAfterDays: 15 },
  ] } }),
  compRepo("client-site-gamma", { classification: "monitored", pushedAt: days(280) }),
  compRepo("old-experiment", { classification: "ignored", pushedAt: days(800) }),
  compRepo("dormant-marketing-site", { classification: "ignored", pushedAt: days(900) }),
  compRepo("legacy-billing", { pushedAt: days(420) }),
  compRepo("widget-factory", { visibility: "PUBLIC", published: { registry: "npm" }, pushedAt: days(60) }),
  compRepo("hackathon-2023", { pushedAt: days(950) }),
];

const compliance = {
  repos: complianceRepos,
  summary: {
    total: complianceRepos.length,
    inScope: complianceRepos.filter((r) => r.scope === "in").length,
    outScope: complianceRepos.filter((r) => r.scope === "out").length,
    overridden: complianceRepos.filter((r) => r.scopeOverride).length,
    unprotected: complianceRepos.filter((r) => r.protectionScope && r.protected === false).length,
    dependabotBlocked: complianceRepos.filter((r) => r.dependabot && r.dependabot.state === "blocked").length,
    dependabotStale: complianceRepos.filter((r) => r.dependabot && r.dependabot.state === "stale").length,
  },
  archived: [
    { name: "retired-app-2019", url: "https://github.com/acme-corp/retired-app-2019", pushedAt: days(1500), visibility: "PRIVATE" },
    { name: "old-website", url: "https://github.com/acme-corp/old-website", pushedAt: days(1200), visibility: "PUBLIC" },
  ],
  protectionPending: false,
  enrichPending: false,
};

const settings = {
  estimate: { hourly_rate: 200, setup_hours: 2, patch_hours: 0.5, minor_hours: 1, major_hours: 4, unknown_hours: 1, low_multiplier: 0.8, high_multiplier: 1.4 },
  email: { mode: "mailto", copy_include_address: true, copy_include_subject: true, copy_include_signature: true },
  signatures: [{ id: "sig-default", label: "Default", body: "Best,\nDev User\nAcme Corp" }],
  selected_signature: "sig-default",
};

const engagementLog = {
  "client-site-alpha": [
    { at: days(400), kind: "engagement", from: "untriaged", to: "maintained", note: "New SOW signed.", sowEndDate: null },
    { at: days(90), kind: "engagement", from: "maintained", to: "monitored", note: "SOW ended; client self-manages. Notified of open vulnerabilities.", sowEndDate: "2026-03-15" },
  ],
  "internal-tools-gem": [
    { at: days(20), kind: "scope", from: "in", to: "out", note: "Internal gem — outside the customer boundary.", sowEndDate: null },
  ],
};

// ---- server ------------------------------------------------------------------
const STATIC = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/index.html": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["public/styles.css", "text/css; charset=utf-8"],
};

const json = (res, obj) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const route = u.pathname;
  if (req.method === "GET" && STATIC[route]) {
    const [file, type] = STATIC[route];
    res.writeHead(200, { "Content-Type": type });
    return res.end(fs.readFileSync(path.join(REPO, file)));
  }
  if (route === "/api/health") return json(res, { ok: true, login: "dev-user", org: "acme-corp", draftPRs: true });
  if (route === "/api/repos") return json(res, model);
  if (route === "/api/events") {
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" });
    res.write(JSON.stringify({ type: "hello", maxConcurrent: 3 }) + "\n");
    return; // keep open
  }
  if (route === "/api/pr-status") return json(res, { autoFixCI: true, statuses: ciStatuses, prMeta });
  if (route === "/api/eol-status") return json(res, { autoUpgradeEOL: true, eol: eolStatus });
  if (route === "/api/protection-status") return json(res, { protection });
  if (route === "/api/compliance") return json(res, compliance);
  if (route === "/api/settings") return json(res, settings);
  if (route === "/api/engagement-log") return json(res, { repo: u.searchParams.get("repo"), log: engagementLog[u.searchParams.get("repo")] || [] });
  // Mutating endpoints: accept and pretend success (nothing persists).
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let b = {};
      try { b = JSON.parse(body || "{}"); } catch {}
      if (route === "/api/classify") return json(res, { repo: b.repo, state: b.state || "untriaged", engagement: null });
      if (route === "/api/contact") return json(res, { repo: b.repo, contact: { name: b.name || "", email: b.email || "" } });
      if (route === "/api/notify") return json(res, { repo: b.repo, notifiedAt: b.clear ? null : new Date().toISOString() });
      if (route === "/api/scope-override") return json(res, { repo: b.repo, scope: b.scope || "out", override: b.scope ? { scope: b.scope, reason: b.reason } : null, derived: "out" });
      if (route === "/api/protect-branch") return json(res, { repo: b.repo, branch: "main", updated: false, rulesetId: 1 });
      if (route === "/api/unprotect-branch") return json(res, { repo: b.repo, removed: true, stillProtected: false, via: null });
      // Reviewer edits echo the resulting set (like the real server) instead of a bare ok —
      // the picker renders from that response, so a canned reply would make it look broken.
      if (route === "/api/request-review") {
        const repo = repos.find((r) => r.name === b.repo);
        const pr = repo && (repo.openPRs || []).find((p) => p.number === Number(b.number));
        const display = (h) => String(h).split("/").pop();
        const add = Array.isArray(b.add) ? b.add : b.reviewer ? [b.reviewer] : [];
        const gone = new Set((Array.isArray(b.remove) ? b.remove : []).map(display));
        const reviewers = pr
          ? [...new Set([...(pr.reviewers || []).filter((x) => !gone.has(x)), ...add.map(display)])]
          : [];
        if (pr) pr.reviewers = reviewers; // persists for this process, so a re-render agrees
        return json(res, { repo: b.repo, number: Number(b.number), added: add, removed: [...gone], reviewers });
      }
      json(res, { ok: true });
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
}).listen(PORT, "127.0.0.1", () => console.log(`mock dashboard on http://127.0.0.1:${PORT}`));
