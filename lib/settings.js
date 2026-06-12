"use strict";

// User-editable settings (estimate knobs + email signatures), stored as TOML at
// the project root. Edited via the in-app Settings panel or by hand. A tiny,
// schema-specific TOML reader/writer keeps the project dependency-free — it is
// NOT a general TOML parser, just enough for this file's shape.

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "settings.toml");

const DEFAULTS = {
  estimate: {
    hourly_rate: 200,
    patch_hours: 0.25,
    minor_hours: 0.5,
    major_hours: 2,
    unknown_hours: 0.5, // "default LoE" for packages we can't classify
    setup_hours: 1,
    low_multiplier: 1.2,
    high_multiplier: 1.6,
  },
  email: {
    mode: "mailto", // "mailto" | "copy"
    copy_include_address: true,
    copy_include_subject: true,
    copy_include_signature: true,
  },
  selected_signature: "",
  // No signatures shipped by default — add your own via the Settings panel.
  signatures: [],
};

const ESTIMATE_KEYS = Object.keys(DEFAULTS.estimate);

// ---- tiny TOML (schema-specific) -------------------------------------------
function escStr(v) {
  return '"' + String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n") + '"';
}
function unescStr(s) {
  return s.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

function serialize(s) {
  const e = s.estimate;
  const lines = [
    "# Dependency Dashboard — settings",
    "# Edit here or via the in-app Settings panel (gear icon).",
    "",
    `selected_signature = ${escStr(s.selected_signature)}`,
    "",
    "[estimate]",
    ...ESTIMATE_KEYS.map((k) => `${k} = ${Number(e[k])}`),
    "",
    "[email]",
    `mode = ${escStr(s.email.mode)}`,
    `copy_include_address = ${s.email.copy_include_address ? "true" : "false"}`,
    `copy_include_subject = ${s.email.copy_include_subject ? "true" : "false"}`,
    `copy_include_signature = ${s.email.copy_include_signature ? "true" : "false"}`,
    "",
  ];
  for (const sig of s.signatures) {
    lines.push("[[signature]]");
    lines.push(`id = ${escStr(sig.id)}`);
    lines.push(`label = ${escStr(sig.label)}`);
    lines.push(`body = ${escStr(sig.body)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function parseVal(raw) {
  raw = raw.trim();
  if (raw.startsWith('"')) return unescStr(raw.replace(/^"/, "").replace(/"\s*$/, ""));
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

function parse(text) {
  const out = { estimate: {}, email: {}, signatures: [], selected_signature: null };
  let cur = out;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[estimate]") { cur = out.estimate; continue; }
    if (line === "[email]") { cur = out.email; continue; }
    if (line === "[[signature]]") { const sig = {}; out.signatures.push(sig); cur = sig; continue; }
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) cur[m[1]] = parseVal(m[2]);
  }
  return out;
}

// ---- normalize / load / save -----------------------------------------------
function slug(s) {
  return String(s || "sig").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sig";
}

function normalize(raw) {
  const s = { estimate: {}, email: {}, signatures: [], selected_signature: raw.selected_signature };
  for (const k of ESTIMATE_KEYS) {
    const v = Number(raw.estimate && raw.estimate[k]);
    s.estimate[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULTS.estimate[k];
  }
  const em = raw.email || {};
  s.email = {
    mode: em.mode === "copy" ? "copy" : "mailto",
    copy_include_address: em.copy_include_address !== false,
    copy_include_subject: em.copy_include_subject !== false,
    copy_include_signature: em.copy_include_signature !== false,
  };
  const seen = new Set();
  for (const sig of raw.signatures || []) {
    if (!sig || (!sig.body && !sig.label)) continue;
    let id = slug(sig.id || sig.label);
    while (seen.has(id)) id += "-2";
    seen.add(id);
    s.signatures.push({ id, label: String(sig.label || sig.id || "Signature"), body: String(sig.body || "") });
  }
  if (!s.signatures.find((x) => x.id === s.selected_signature)) {
    s.selected_signature = s.signatures.length ? s.signatures[0].id : "";
  }
  return s;
}

function load() {
  let raw;
  try {
    raw = parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    const seeded = normalize(DEFAULTS);
    try { fs.writeFileSync(FILE, serialize(seeded) + "\n"); } catch {}
    return seeded;
  }
  return normalize(raw);
}

function save(input) {
  const s = normalize(input || {});
  fs.writeFileSync(FILE, serialize(s) + "\n");
  return s;
}

function selectedSignature(s) {
  return s.signatures.find((x) => x.id === s.selected_signature) || s.signatures[0] || null;
}

module.exports = { load, save, selectedSignature, DEFAULTS };
