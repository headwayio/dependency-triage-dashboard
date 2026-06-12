"use strict";

// SOC 2 branch-protection rulesets. Builds a "protect the default branch" ruleset
// (require a reviewed PR, no force-push, no deletion), checks whether a repo's
// default branch is protected at all, and applies/updates the ruleset via the
// GitHub rulesets API. Targets ~DEFAULT_BRANCH so one ruleset covers main OR master.

const fsSync = require("fs");
const os = require("os");
const path = require("path");
const { run } = require("./exec");

const DEFAULT_NAME = "SOC 2 — protected default branch";

/** Build the ruleset JSON from config.protection (with SOC 2 defaults). */
function buildRuleset(config) {
  const p = (config && config.protection) || {};
  const prParams = {
    required_approving_review_count: p.requiredApprovals != null ? p.requiredApprovals : 1,
    dismiss_stale_reviews_on_push: p.dismissStaleReviews !== false,
    require_code_owner_review: !!p.requireCodeOwnerReview,
    require_last_push_approval: !!p.requireLastPushApproval,
    required_review_thread_resolution: p.requireConversationResolution !== false,
  };
  const rules = [{ type: "pull_request", parameters: prParams }];
  if (p.blockForcePush !== false) rules.push({ type: "non_fast_forward" });
  if (p.restrictDeletion !== false) rules.push({ type: "deletion" });
  // No bypass by default (strict): even admins must open a reviewed PR. If
  // allowAdminBypass is set, repository admins (role id 5) may bypass.
  const bypassActors = p.allowAdminBypass
    ? [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }]
    : [];
  return {
    name: p.rulesetName || DEFAULT_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules,
    bypass_actors: bypassActors,
  };
}

/**
 * Is the default branch protected at all? Considers an active branch ruleset OR a
 * classic branch-protection record. Also returns the id of OUR ruleset (by name),
 * so apply can update-in-place instead of erroring on a duplicate name.
 */
async function checkProtection(nwo, defaultBranch, rulesetName) {
  const name = rulesetName || DEFAULT_NAME;
  let hasRuleset = false;
  let ourId = null;
  const rs = await run("gh", ["api", `repos/${nwo}/rulesets`]);
  if (rs.code === 0) {
    try {
      for (const r of JSON.parse(rs.stdout) || []) {
        if (r.target === "branch" && r.enforcement === "active") hasRuleset = true;
        if (r.name === name) ourId = r.id;
      }
    } catch {
      /* ignore parse error */
    }
  }
  if (hasRuleset) return { protected: true, via: "ruleset", ourId };
  if (defaultBranch) {
    const cl = await run("gh", ["api", `repos/${nwo}/branches/${defaultBranch}/protection`]);
    if (cl.code === 0) return { protected: true, via: "classic", ourId };
  }
  return { protected: false, via: null, ourId };
}

/** Create (or update, if it already exists) our ruleset on a repo. */
async function applyProtection(nwo, config, existingId) {
  const ruleset = buildRuleset(config);
  const file = path.join(os.tmpdir(), `ruleset-${nwo.replace(/[^a-z0-9]+/gi, "_")}.json`);
  fsSync.writeFileSync(file, JSON.stringify(ruleset));
  const args = existingId
    ? ["api", "--method", "PUT", `repos/${nwo}/rulesets/${existingId}`, "--input", file]
    : ["api", "--method", "POST", `repos/${nwo}/rulesets`, "--input", file];
  const res = await run("gh", args);
  try {
    fsSync.unlinkSync(file);
  } catch {
    /* temp cleanup */
  }
  if (res.code !== 0) {
    throw new Error((res.stderr || res.stdout || "ruleset apply failed").slice(0, 400));
  }
  let out = {};
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* non-JSON */
  }
  return { id: out.id, name: out.name, updated: !!existingId, url: (out._links && out._links.html && out._links.html.href) || null };
}

/**
 * Remove OUR ruleset from a repo — only the one this tool created (matched by
 * name via checkProtection's ourId). Protection applied any other way (classic
 * branch protection, a foreign ruleset) is refused with err.foreign = true:
 * deleting controls we didn't create belongs in the repo's GitHub settings.
 * Returns { removed, stillProtected, via } — the branch may remain protected
 * by something else even after our ruleset is gone.
 */
async function removeProtection(nwo, defaultBranch, rulesetName) {
  const st = await checkProtection(nwo, defaultBranch, rulesetName);
  if (!st.ourId) {
    if (st.protected) {
      const e = new Error(
        `${nwo} is protected by ${st.via === "classic" ? "classic branch protection" : "a ruleset"} this tool didn't create — remove it from the repo's Settings → Rules on GitHub.`
      );
      e.foreign = true;
      throw e;
    }
    return { removed: false, stillProtected: false, via: null };
  }
  const res = await run("gh", ["api", "--method", "DELETE", `repos/${nwo}/rulesets/${st.ourId}`]);
  if (res.code !== 0) {
    throw new Error((res.stderr || res.stdout || "ruleset delete failed").slice(0, 400));
  }
  const after = await checkProtection(nwo, defaultBranch, rulesetName);
  return { removed: true, stillProtected: after.protected, via: after.via };
}

module.exports = { buildRuleset, checkProtection, applyProtection, removeProtection, DEFAULT_NAME };
