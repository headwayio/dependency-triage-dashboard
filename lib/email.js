"use strict";

// Generates a client-facing HTML email alerting them to outdated / vulnerable
// dependencies in one of their apps, with an hourly-engagement estimate derived
// from the real major/minor/patch breakdown (installed → patched, via semver).

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

// Fallbacks if settings aren't supplied (the Settings panel / settings.toml is
// the real source of these).
const DEFAULT_EST = {
  hourly_rate: 200,
  patch_hours: 0.25,
  minor_hours: 0.5,
  major_hours: 2,
  unknown_hours: 0.5,
  setup_hours: 1,
  low_multiplier: 1.2,
  high_multiplier: 1.6,
};

// Plain-English roles for common packages, so a non-technical reader gets the
// gist. Unknown packages fall back to a generic, still-honest description.
const ROLES = {
  // Ruby / Rails
  puma: "the web server that runs the application",
  rails: "the core web framework the app is built on",
  activesupport: "core framework utilities",
  activestorage: "file upload & storage handling",
  actionview: "the framework's page-rendering layer",
  actionpack: "the framework's request-handling layer",
  rack: "the web request/response layer beneath the app",
  "rack-session": "user session handling",
  "net-imap": "email (IMAP) handling",
  devise: "the user login & authentication system",
  nokogiri: "the library that parses XML/HTML",
  loofah: "HTML sanitization that helps block injection attacks",
  rexml: "XML parsing",
  erb: "the page-templating engine",
  addressable: "URL parsing & handling",
  bcrypt: "password encryption",
  "aws-sdk-s3": "Amazon S3 file-storage integration",
  icalendar: "calendar (iCal) handling",
  view_component: "reusable UI building blocks",
  // JavaScript / npm
  lodash: "common JavaScript utility functions",
  axios: "the library used to make web/API requests",
  express: "the web server framework",
  "follow-redirects": "HTTP request handling",
  postcss: "CSS build tooling",
  vite: "the front-end build tool",
  rollup: "the front-end bundler",
  webpack: "the front-end bundler",
  moment: "date & time handling",
  qs: "web form / query parsing",
  "form-data": "file-upload request handling",
  "tough-cookie": "cookie handling",
  minimatch: "file-path matching",
  "brace-expansion": "pattern expansion utility",
  semver: "version-number handling",
  ws: "real-time websocket connections",
  ajv: "data validation",
  json5: "configuration parsing",
  "cross-spawn": "running sub-processes",
  minimist: "command-line argument parsing",
  tmp: "temporary-file handling",
  uuid: "unique-id generation",
  // PHP / composer
  symfony: "PHP framework components",
  guzzlehttp: "HTTP request handling",
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

const ECO_WORD = { npm: "JavaScript", rubygems: "Ruby", composer: "PHP", go: "Go", pip: "Python" };

function roleFor(pkg, eco) {
  const base = String(pkg).toLowerCase().split("/").pop();
  return ROLES[String(pkg).toLowerCase()] || ROLES[base] || `a ${ECO_WORD[eco] || "software"} library`;
}

function hasRole(pkg) {
  const n = String(pkg).toLowerCase();
  return !!(ROLES[n] || ROLES[n.split("/").pop()]);
}

function humanize(name) {
  return String(name).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function appName(repo) {
  return (repo.description && repo.description.trim()) || humanize(repo.name);
}

function sevWord(s) {
  return s === "critical" ? "critical" : s === "high" ? "high-severity" : s === "medium" ? "moderate" : "low-severity";
}

function parseVer(v) {
  const m = String(v || "").replace(/^[^0-9]*/, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
}

function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// Classify the bump from installed → patched. Without an installed version we
// can't be sure, so it's "unknown" (counted at a middle effort weight).
function classifyBump(installed, patched) {
  const a = parseVer(installed), b = parseVer(patched);
  if (!a || !b) return "unknown";
  if (b[0] > a[0]) return "major";
  if (b[0] === a[0] && b[1] > a[1]) return "minor";
  return "patch";
}

// Collapse alerts to distinct packages (max severity, highest required patch).
function distinctPackages(repo) {
  const byKey = new Map();
  for (const p of repo.packages || []) {
    const key = `${p.ecosystem}|${p.pkg}`;
    const ex = byKey.get(key);
    if (!ex) {
      byKey.set(key, { pkg: p.pkg, ecosystem: p.ecosystem, severity: p.severity, patched: p.patched });
    } else {
      if ((SEV_RANK[p.severity] ?? 9) < (SEV_RANK[ex.severity] ?? 9)) ex.severity = p.severity;
      if (p.patched && (!ex.patched || cmpVer(p.patched, ex.patched) > 0)) ex.patched = p.patched;
    }
  }
  return [...byKey.values()];
}

function money(n) {
  return n.toLocaleString("en-US");
}

function buildClientEmail(repo, installed, opts = {}) {
  const E = { ...DEFAULT_EST, ...(opts.estimate || {}) };
  const rate = E.hourly_rate;
  const signature = (opts.signature && opts.signature.body) || "";
  const pkgs = distinctPackages(repo);
  const counts = {
    updates: pkgs.length,
    critical: 0, high: 0, medium: 0, low: 0,
    major: 0, minor: 0, patch: 0, unknown: 0,
  };
  for (const p of pkgs) {
    if (counts[p.severity] !== undefined) counts[p.severity]++;
    p.type = classifyBump(installed[p.pkg], p.patched);
    counts[p.type]++;
  }

  const work =
    counts.patch * E.patch_hours +
    counts.minor * E.minor_hours +
    counts.major * E.major_hours +
    counts.unknown * E.unknown_hours;
  const base = E.setup_hours + work;
  const lowH = Math.max(2, Math.round(base * E.low_multiplier));
  const highH = Math.max(lowH + 1, Math.round(base * E.high_multiplier));
  const round100 = (x) => Math.round(x / 100) * 100;
  const est = { lowH, highH, lowD: round100(lowH * rate), highD: round100(highH * rate) };

  // Highest severity first; within a severity, prefer packages we can describe
  // in plain English so the examples are relatable.
  const examples = pkgs
    .slice()
    .sort(
      (a, b) =>
        (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) ||
        hasRole(b.pkg) - hasRole(a.pkg)
    )
    .slice(0, 3);

  const name = (opts.contact && opts.contact.name) || "[Client name]";
  const to = (opts.contact && opts.contact.email) || "";
  const subject = `Dependency & security update — ${appName(repo)}`;
  const cfg = {
    mode: "mailto",
    copy_include_address: true,
    copy_include_subject: true,
    copy_include_signature: true,
    ...(opts.email || {}),
  };

  const bHtml = bodyHtml(repo, counts, est, examples);
  const bText = bodyText(repo, counts, est, examples);
  const greetText = `Hi ${name},`;
  const closeText = signature ? `Thanks,\n\n${signature}` : "Thanks,";
  const summary = { ...counts, ...est, rate };

  if (cfg.mode === "mailto") {
    // Skeleton (greeting + blank gap + sign-off) opens in the mail app; the full
    // body is copied so the user pastes it into the gap.
    return {
      mode: "mailto",
      to,
      subject,
      mailtoBody: `${greetText}\n\n\n\n${closeText}`,
      clipboardHtml: wrap(bHtml),
      clipboardText: bText,
      summary,
    };
  }

  // Copy-only: assemble the whole email per the include-* toggles.
  const preH = [];
  const preT = [];
  if (cfg.copy_include_address && to) {
    preH.push(`<p style="margin:0;color:#57606a;">To: ${esc(to)}</p>`);
    preT.push(`To: ${to}`);
  }
  if (cfg.copy_include_subject) {
    preH.push(`<p style="margin:0 0 10px;color:#57606a;">Subject: ${esc(subject)}</p>`);
    preT.push(`Subject: ${subject}`);
  }
  const sigH = cfg.copy_include_signature ? closingHtml(signature) : "";
  const sigT = cfg.copy_include_signature ? `\n\n${closeText}` : "";
  return {
    mode: "copy",
    to,
    subject,
    clipboardHtml: wrap(preH.join("") + greetingHtml(name) + bHtml + sigH),
    clipboardText: (preT.length ? preT.join("\n") + "\n\n" : "") + greetText + "\n\n" + bText + sigT,
    summary,
  };
}

function vulnLine(counts) {
  const vuln = counts.critical + counts.high;
  if (!vuln) return ".";
  const bits = [];
  if (counts.critical) bits.push(`${counts.critical} critical`);
  if (counts.high) bits.push(`${counts.high} high-severity`);
  return `, including <strong style="color:#b3261e;">${vuln} with known security vulnerabilities</strong> (${bits.join(", ")}).`;
}

function typeBreakdown(counts) {
  const parts = [];
  if (counts.major) parts.push(`${counts.major} major`);
  if (counts.minor) parts.push(`${counts.minor} minor`);
  if (counts.patch) parts.push(`${counts.patch} patch`);
  if (counts.unknown) parts.push(`${counts.unknown} to confirm`);
  return parts.join(", ") || `${counts.updates}`;
}

const WRAP_OPEN =
  `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2328;font-size:15px;line-height:1.6;max-width:600px;">`;
function wrap(inner) {
  return WRAP_OPEN + inner + `</div>`;
}
function greetingHtml(name) {
  return `<p>Hi ${esc(name)},</p>`;
}
function closingHtml(signature) {
  const sigHtml = signature
    ? `<p style="margin-top:14px;margin-bottom:0;line-height:1.5;">${signature.split("\n").map((l) => esc(l)).join("<br>")}</p>`
    : "";
  return `<p style="margin-top:22px;margin-bottom:0;">Thanks,</p>` + sigHtml;
}

// The middle body (no greeting, no sign-off/signature) — shared by both modes.
function bodyHtml(repo, counts, est, examples) {
  const app = esc(appName(repo));
  const exHtml = examples
    .map(
      (p) =>
        `<li style="margin-bottom:7px;"><strong>${esc(p.pkg)}</strong> &mdash; ${esc(roleFor(p.pkg, p.ecosystem))} <span style="color:#8a8f98;">(${sevWord(p.severity)})</span></li>`
    )
    .join("");
  return `
  <p>As part of keeping <strong>${app}</strong> healthy and secure, we reviewed the third-party software dependencies it relies on &mdash; the open-source building blocks behind nearly every modern application. A number of them have fallen behind, and several carry <strong>known security vulnerabilities</strong> worth getting ahead of.</p>

  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f6f8fa;border:1px solid #e2e6ea;border-radius:8px;margin:18px 0;">
    <tr><td style="padding:14px 18px;">
      <div style="font-size:13px;letter-spacing:.02em;text-transform:uppercase;color:#57606a;margin-bottom:6px;">What we found in ${app}</div>
      <div><strong>${counts.updates} dependencies</strong> that should be updated${vulnLine(counts)}</div>
    </td></tr>
  </table>

  <p>In plain terms: out-of-date dependencies are one of the most common ways an application becomes vulnerable &mdash; the kind of gap that can lead to data exposure, downtime, or a failed security/compliance review (such as SOC&nbsp;2). They also tend to get harder and costlier to resolve the longer they sit, as changes pile up.</p>

  <p>A few of the more pressing items:</p>
  <ul style="margin:0 0 18px 0;padding-left:22px;">${exHtml}</ul>

  <p>The good news: this is routine maintenance we handle regularly, and it requires nothing on your end.</p>

  <p><strong>What we'd suggest.</strong> We'd like to bring ${app}'s dependencies current and patch the known vulnerabilities for you. Based on the ${counts.updates} updates involved (${typeBreakdown(counts)}), we estimate roughly <strong>${est.lowH}&ndash;${est.highH} hours</strong> &mdash; about <strong>$${money(est.lowD)}&ndash;$${money(est.highD)}</strong> &mdash; to update, test, and deploy, with every change delivered as a pull request your team can review.${counts.major ? " The major updates may warrant a little extra validation, which is reflected in the range." : ""}</p>

  <p>Happy to walk through any of this, or get started whenever you'd like.</p>`;
}

function bodyText(repo, counts, est, examples) {
  const app = appName(repo);
  const vuln = counts.critical + counts.high;
  const exLines = examples.map((p) => `  - ${p.pkg} — ${roleFor(p.pkg, p.ecosystem)} (${sevWord(p.severity)})`).join("\n");
  return [
    `As part of keeping ${app} healthy and secure, we reviewed the third-party software dependencies it relies on — the open-source building blocks behind nearly every modern application. A number of them have fallen behind, and several carry known security vulnerabilities worth getting ahead of.`,
    ``,
    `What we found in ${app}: ${counts.updates} dependencies that should be updated${vuln ? `, including ${vuln} with known security vulnerabilities (${counts.critical} critical, ${counts.high} high-severity).` : "."}`,
    ``,
    `In plain terms: out-of-date dependencies are one of the most common ways an application becomes vulnerable — the kind of gap that can lead to data exposure, downtime, or a failed security/compliance review (such as SOC 2). They also tend to get harder and costlier to resolve the longer they sit.`,
    ``,
    `A few of the more pressing items:`,
    exLines,
    ``,
    `The good news: this is routine maintenance we handle regularly, and it requires nothing on your end.`,
    ``,
    `What we'd suggest. We'd like to bring ${app}'s dependencies current and patch the known vulnerabilities for you. Based on the ${counts.updates} updates involved (${typeBreakdown(counts).replace(/<[^>]+>/g, "")}), we estimate roughly ${est.lowH}–${est.highH} hours — about $${money(est.lowD)}–$${money(est.highD)} — to update, test, and deploy, with every change delivered as a pull request your team can review.`,
    ``,
    `Happy to walk through any of this, or get started whenever you'd like.`,
  ].join("\n");
}

module.exports = { buildClientEmail };
