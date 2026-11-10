import { createRequire as __slipwayRequire } from 'node:module'; const require = __slipwayRequire(import.meta.url);

// src/mcp/hook.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { resolve as resolve2 } from "node:path";

// src/config.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/env.ts
function slipwayEnv(name, env = process.env) {
  return env[`SLIPWAY_${name}`] || void 0;
}

// src/config.ts
function slipwayHome() {
  return slipwayEnv("HOME") || join(homedir(), ".slipway");
}
function configPath() {
  return join(slipwayHome(), "config.json");
}
function loadConfig() {
  const p = configPath();
  if (!existsSync(p)) {
    throw new Error(`Slipway is not configured (${p} missing). Run "slipway init" first.`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

// src/gitea/client.ts
var GiteaError = class extends Error {
  constructor(status, method, path, body) {
    super(`Gitea API ${method} ${path} failed: ${status} ${body.slice(0, 500)}`);
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
  status;
  method;
  path;
  body;
};
var GiteaClient = class {
  constructor(baseUrl, auth, fetchImpl = fetch) {
    this.baseUrl = baseUrl;
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }
  baseUrl;
  auth;
  fetchImpl;
  async req(method, path, body, accept = "application/json") {
    const headers = { accept, "content-type": "application/json" };
    if (typeof this.auth === "string") headers.authorization = `token ${this.auth}`;
    else headers.authorization = "Basic " + Buffer.from(this.auth.basic.join(":")).toString("base64");
    const res = await this.fetchImpl(this.baseUrl.replace(/\/$/, "") + "/api/v1" + path, {
      method,
      headers,
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new GiteaError(res.status, method, path, text);
    if (accept !== "application/json") return text;
    return text ? JSON.parse(text) : void 0;
  }
  /** Fetches all pages of a list endpoint. */
  async all(path) {
    const out = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page < 100; page++) {
      const items = await this.req("GET", `${path}${sep}limit=50&page=${page}`);
      out.push(...items);
      if (items.length < 50) break;
    }
    return out;
  }
  version() {
    return this.req("GET", "/version");
  }
  // ---- users & tokens -------------------------------------------------------
  async createToken(username, name, scopes) {
    try {
      await this.req("DELETE", `/users/${username}/tokens/${encodeURIComponent(name)}`);
    } catch (e) {
      if (!(e instanceof GiteaError && e.status === 404)) throw e;
    }
    const t = await this.req("POST", `/users/${username}/tokens`, { name, scopes });
    return t.sha1;
  }
  // ---- repos ------------------------------------------------------------------
  createRepo(name, description = "") {
    return this.req("POST", "/user/repos", { name, description, private: true, auto_init: false, default_branch: "main" });
  }
  getRepo(owner, repo) {
    return this.req("GET", `/repos/${owner}/${repo}`);
  }
  editRepo(owner, repo, opts) {
    return this.req("PATCH", `/repos/${owner}/${repo}`, opts);
  }
  addCollaborator(owner, repo, user, permission) {
    return this.req("PUT", `/repos/${owner}/${repo}/collaborators/${user}`, { permission });
  }
  listBranchProtections(owner, repo) {
    return this.req("GET", `/repos/${owner}/${repo}/branch_protections`);
  }
  createBranchProtection(owner, repo, opts) {
    return this.req("POST", `/repos/${owner}/${repo}/branch_protections`, opts);
  }
  editBranchProtection(owner, repo, name, opts) {
    return this.req("PATCH", `/repos/${owner}/${repo}/branch_protections/${encodeURIComponent(name)}`, opts);
  }
  // ---- pulls --------------------------------------------------------------------
  getPull(owner, repo, idx) {
    return this.req("GET", `/repos/${owner}/${repo}/pulls/${idx}`);
  }
  listPulls(owner, repo, state = "open") {
    return this.all(`/repos/${owner}/${repo}/pulls?state=${state}`);
  }
  createPull(owner, repo, opts) {
    return this.req("POST", `/repos/${owner}/${repo}/pulls`, opts);
  }
  editPull(owner, repo, idx, opts) {
    return this.req("PATCH", `/repos/${owner}/${repo}/pulls/${idx}`, opts);
  }
  closePull(owner, repo, idx) {
    return this.editPull(owner, repo, idx, { state: "closed" });
  }
  mergePull(owner, repo, idx, style = "merge") {
    return this.req("POST", `/repos/${owner}/${repo}/pulls/${idx}/merge`, { Do: style });
  }
  pullDiff(owner, repo, idx) {
    return this.req("GET", `/repos/${owner}/${repo}/pulls/${idx}.diff`, void 0, "text/plain");
  }
  listReviews(owner, repo, idx) {
    return this.all(`/repos/${owner}/${repo}/pulls/${idx}/reviews`);
  }
  listReviewComments(owner, repo, idx, reviewId) {
    return this.req("GET", `/repos/${owner}/${repo}/pulls/${idx}/reviews/${reviewId}/comments`);
  }
  createReview(owner, repo, idx, opts) {
    return this.req("POST", `/repos/${owner}/${repo}/pulls/${idx}/reviews`, opts);
  }
  replyToComment(owner, repo, idx, commentId, body) {
    return this.req("POST", `/repos/${owner}/${repo}/pulls/${idx}/comments/${commentId}/replies`, { body });
  }
  resolveComment(owner, repo, commentId) {
    return this.req("POST", `/repos/${owner}/${repo}/pulls/comments/${commentId}/resolve`);
  }
  /** All review comments (with review metadata), oldest review first. */
  async allReviewComments(owner, repo, idx) {
    const reviews = await this.listReviews(owner, repo, idx);
    const out = [];
    for (const review of reviews) {
      for (const comment of await this.listReviewComments(owner, repo, idx, review.id)) out.push({ review, comment });
    }
    return out;
  }
  /**
   * Feedback the agent still has to address: inline threads with no resolver (a thread = path+line,
   * resolved if any comment in it is resolved), from non-dismissed reviews, not written by the agent.
   * The body of the latest non-dismissed "request changes" review is returned first as a general item (id 0).
   */
  async unresolvedComments(owner, repo, idx, agentLogin) {
    const reviews = await this.listReviews(owner, repo, idx);
    const live = reviews.filter((r) => !r.dismissed);
    const all = [];
    for (const review of reviews) {
      for (const comment of await this.listReviewComments(owner, repo, idx, review.id)) all.push({ review, comment });
    }
    const key = (c) => `${c.path}:${c.position || c.original_position}`;
    const resolved = new Set(all.filter(({ comment }) => comment.resolver).map(({ comment }) => key(comment)));
    const out = [];
    const lastRejected = [...live].reverse().find((r) => r.state === "REQUEST_CHANGES" && r.user?.login !== agentLogin);
    if (lastRejected?.body?.trim()) {
      out.push({ id: 0, path: "", line: 0, body: lastRejected.body.trim(), author: lastRejected.user?.login ?? "", diffHunk: "" });
    }
    for (const { review, comment } of all) {
      if (review.dismissed || comment.resolver || comment.user.login === agentLogin || resolved.has(key(comment))) continue;
      out.push({
        id: comment.id,
        path: comment.path,
        line: comment.position || comment.original_position,
        body: comment.body,
        author: comment.user.login,
        diffHunk: comment.diff_hunk ?? ""
      });
    }
    return out;
  }
  // ---- issues/comments/labels ---------------------------------------------------
  comment(owner, repo, idx, body) {
    return this.req("POST", `/repos/${owner}/${repo}/issues/${idx}/comments`, { body });
  }
  listComments(owner, repo, idx) {
    return this.all(`/repos/${owner}/${repo}/issues/${idx}/comments`);
  }
  /** Admin: create a user (requires the owner/admin token). */
  adminCreateUser(opts) {
    return this.req("POST", "/admin/users", { ...opts, must_change_password: false, send_notify: false });
  }
  adminEditUser(username, opts) {
    return this.req("PATCH", `/admin/users/${username}`, { ...opts, login_name: username, source_id: 0, must_change_password: false });
  }
  createOrg(name) {
    return this.req("POST", "/orgs", { username: name, visibility: "private", repo_admin_change_team_access: false });
  }
  listTeams(org) {
    return this.req("GET", `/orgs/${org}/teams`);
  }
  createTeam(org, name) {
    return this.req("POST", `/orgs/${org}/teams`, {
      name,
      description: "Slipway reviewers: write access to every review repo, no repo admin",
      permission: "write",
      units_map: { "repo.code": "write", "repo.pulls": "write" },
      includes_all_repositories: true,
      can_create_org_repo: false
    });
  }
  addTeamMember(teamId, username) {
    return this.req("PUT", `/teams/${teamId}/members/${username}`);
  }
  createOrgRepo(org, name, description = "") {
    return this.req("POST", `/orgs/${org}/repos`, { name, description, private: true, auto_init: false, default_branch: "main" });
  }
  /** Moves a repo (with its PRs, reviews and comments) to another owner. As site admin the transfer is immediate. */
  transferRepo(owner, repo, newOwner) {
    return this.req("POST", `/repos/${owner}/${repo}/transfer`, { new_owner: newOwner });
  }
};

// src/util/exec.ts
import { spawn } from "node:child_process";
function run(cmd, args, opts = {}) {
  return new Promise((resolve3) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timer;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        stderr += `
[slipway] timed out after ${opts.timeoutMs} ms`;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve3({ code: err.code === "ENOENT" ? 127 : 1, stdout, stderr: stderr + String(err.message) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve3({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(opts.input ?? "");
  });
}

// src/mcp/context.ts
import { existsSync as existsSync2, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
var NotRegisteredError = class extends Error {
  constructor(where) {
    super(`${where} is not a Slipway repo. Ask the user to run: slipway repo add <path-to-the-clone>`);
  }
};
var real = (p) => existsSync2(p) ? realpathSync(p) : resolve(p);
async function resolveRepo(cwd, config) {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (top.code !== 0) throw new NotRegisteredError(cwd);
  const common = (await run("git", ["rev-parse", "--git-common-dir"], { cwd })).stdout.trim();
  const mainClone = real(dirname(resolve(cwd, common)));
  const found = Object.entries(config.repos).find(([, r]) => real(r.path) === mainClone);
  if (!found) throw new NotRegisteredError(mainClone);
  const head = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
  return { name: found[0], entry: found[1], worktree: top.stdout.trim(), branch: head && head !== "HEAD" ? head : null };
}

// src/mcp/hook.ts
var GH_PR_WRITES = /* @__PURE__ */ new Set(["create", "edit", "merge", "close", "reopen", "ready", "review", "comment"]);
var WRITE_METHODS = /^(POST|PATCH|PUT|DELETE)$/i;
var PUSH_OPTS_WITH_VALUE = /* @__PURE__ */ new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
var GH_PR_OPTS_WITH_VALUE = /* @__PURE__ */ new Set([
  "-R",
  "--repo",
  "-t",
  "--title",
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-B",
  "--base",
  "-H",
  "--head",
  "-a",
  "--assignee",
  "-l",
  "--label",
  "-m",
  "--milestone",
  "-p",
  "--project",
  "-r",
  "--reviewer",
  "--add-label",
  "--remove-label",
  "--add-assignee",
  "--remove-assignee",
  "--add-reviewer",
  "--remove-reviewer",
  "--add-project",
  "--remove-project",
  "-c",
  "--comment",
  "--template",
  "--recover",
  "--subject",
  "--author-email",
  "--match-head-commit",
  "--delete-branch-on-merge"
]);
function words(segment) {
  const w = segment.trim().split(/\s+/).filter(Boolean);
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
  return w;
}
function gitSubcommandIndex(w) {
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (a === "-c" || a === "-C" || a === "--git-dir" || a === "--work-tree") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return i;
  }
  return -1;
}
var GH_API_OPTS_WITH_VALUE = /* @__PURE__ */ new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "-p",
  "--preview",
  "--cache"
]);
function ghApiEndpoint(w) {
  for (let i = 2; i < w.length; i++) {
    const a = w[i];
    if (GH_API_OPTS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return unquote(a);
  }
  return null;
}
var MUTATION = /\bmutation\b/;
function graphqlWrites(w, command, cwd) {
  if (MUTATION.test(command)) return true;
  const files = [];
  for (let i = 2; i < w.length; i++) {
    const a = w[i];
    if (a === "--input") files.push(unquote(w[i + 1] ?? ""));
    else if (a.startsWith("--input=")) files.push(unquote(a.slice("--input=".length)));
    const field = a === "-F" || a === "--field" ? unquote(w[i + 1] ?? "") : a.startsWith("--field=") ? unquote(a.slice("--field=".length)) : "";
    const at = field.indexOf("=@");
    if (at > 0) files.push(field.slice(at + 2));
  }
  for (const f of files) {
    if (f === "-" || f === "") continue;
    try {
      if (MUTATION.test(readFileSync2(resolve2(cwd, f.replace(/^~(?=\/)/, homedir2())), "utf8"))) return true;
    } catch {
      return true;
    }
  }
  return false;
}
function ghApiWrites(w, command, cwd) {
  if (ghApiEndpoint(w) === "graphql") return graphqlWrites(w, command, cwd);
  for (let i = 2; i < w.length; i++) {
    const a = w[i];
    if ((a === "-X" || a === "--method") && WRITE_METHODS.test(w[i + 1] ?? "")) return true;
    if (/^(-X|--method=)(POST|PATCH|PUT|DELETE)$/i.test(a)) return true;
    if (["-f", "-F", "--field", "--raw-field", "--input"].includes(a) || /^--(raw-)?field=/.test(a)) return true;
  }
  return false;
}
var unquote = (s) => s.replace(/^(['"])(.*)\1$/, "$2");
function pushedBranches(args) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all" || a === "--mirror" || a === "--branches" || a === "--tags") return "all";
    if (PUSH_OPTS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    positional.push(unquote(a));
  }
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) return [null];
  const out = [];
  for (const spec of refspecs) {
    const s = spec.replace(/^\+/, "");
    const dst = s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
    if (dst.includes("*")) return "all";
    if (s.startsWith("refs/tags/") || dst.startsWith("refs/tags/")) return "all";
    const name = dst.replace(/^refs\/heads\//, "");
    out.push(name === "" || name === "HEAD" || name === "@" ? null : name);
  }
  return out;
}
function ghPrSelector(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (GH_PR_OPTS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return unquote(a);
  }
  return null;
}
function ghCreateHead(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-H" || a === "--head") return unquote(args[i + 1] ?? "") || null;
    if (a.startsWith("--head=")) return unquote(a.slice("--head=".length)) || null;
  }
  return null;
}
var PUSH_HINT = "push with the slipway_push tool (it pushes to the local review Gitea); GitHub gets the branch through promotion";
async function judgeBranch(branch, what, env) {
  if (!branch) {
    return { block: true, reason: `Slipway: cannot tell which branch ${what} targets (detached HEAD?). In this repo, ${PUSH_HINT}.` };
  }
  let state;
  try {
    state = await env.branchState(branch);
  } catch {
    return { block: true, reason: `Slipway: could not check the Slipway PR for "${branch}" (is Slipway running? \`slipway up\`). Until then, ${PUSH_HINT}.` };
  }
  if (state === "closed") return { block: false };
  if (state === "open") {
    return { block: true, reason: `Slipway: "${branch}" has an open Slipway PR, so ${what} must go through Slipway first: ${PUSH_HINT} (slipway_push, slipway_update_pr, slipway_promote).` };
  }
  return { block: true, reason: `Slipway: "${branch}" has no Slipway PR yet, so ${what} would skip the local review: ${PUSH_HINT}, then slipway_open_pr.` };
}
async function decide(input, env) {
  if (input.tool_name !== "Bash") return { block: false };
  const command = input.tool_input.command ?? "";
  if (!command || !env.isRegistered(input.cwd)) return { block: false };
  if (/\.slipway\/(config\.json|gitea\/(app\.ini|secrets\.json))/.test(command)) {
    return { block: true, reason: "Slipway: do not read Slipway credentials. Use the slipway_* tools instead." };
  }
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const w = words(segment);
    let d = { block: false };
    const exe = (w[0] ?? "").split("/").pop();
    if (w[0] === "git") {
      const i = gitSubcommandIndex(w);
      if (i > 0 && w[i] === "push") {
        const branches = pushedBranches(w.slice(i + 1));
        if (branches === "all") {
          d = { block: true, reason: `Slipway: pushing many branches or tags at once is not covered by a Slipway PR. Push one branch at a time; in this repo, ${PUSH_HINT}.` };
        } else {
          for (const b of branches) {
            d = await judgeBranch(b ?? env.currentBranch(), "pushing it", env);
            if (d.block) break;
          }
        }
      }
    } else if (exe === "slipway" && w[1] === "promote" || exe === "promote.sh") {
      d = { block: true, reason: "Slipway: promotion from the shell is for the user. Use the slipway_promote tool (it requires the user's approval)." };
    } else if (w[0] === "gh" && w[1] === "pr" && GH_PR_WRITES.has(w[2] ?? "")) {
      const args = w.slice(3);
      let branch;
      if (w[2] === "create") {
        branch = ghCreateHead(args) ?? env.currentBranch();
      } else {
        const sel = ghPrSelector(args);
        branch = sel === null ? env.currentBranch() : await env.githubPrHead(sel).catch(() => null);
      }
      d = await judgeBranch(branch, `"gh pr ${w[2]}"`, env);
    } else if (w[0] === "gh" && w[1] === "api" && ghApiWrites(w, command, input.cwd)) {
      d = await judgeBranch(env.currentBranch(), 'writing to GitHub through "gh api"', env);
    }
    if (d.block) return d;
  }
  return { block: false };
}
function hookEnv(config, repo) {
  const token = config.claude?.token ?? config.reviewer.token;
  const gitea = new GiteaClient(config.giteaUrl, token);
  return {
    isRegistered: () => true,
    currentBranch: () => repo.branch,
    async branchState(branch) {
      const pulls = await gitea.listPulls(config.org, repo.name, "all");
      const mine = pulls.filter((p) => p.head.ref === branch);
      if (mine.some((p) => p.state === "open")) return "open";
      return mine.length ? "closed" : "none";
    },
    async githubPrHead(ref) {
      const r = await run("gh", ["pr", "view", ref, "--json", "headRefName", "-q", ".headRefName"], { cwd: repo.worktree, timeoutMs: 15e3 });
      return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    }
  };
}
async function main() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  let config;
  try {
    config = loadConfig();
  } catch {
    return;
  }
  const repo = await resolveRepo(input.cwd, config).catch(() => void 0);
  if (!repo) return;
  const d = await decide(input, hookEnv(config, repo));
  if (d.block) {
    process.stderr.write(d.reason + "\n");
    process.exit(2);
  }
}

// src/mcp/entry-hook.ts
main().catch(() => process.exit(0));
