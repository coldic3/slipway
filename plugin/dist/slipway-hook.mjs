import { createRequire as __slipwayRequire } from 'node:module'; const require = __slipwayRequire(import.meta.url);

// src/mcp/hook.ts
import { readFileSync as readFileSync2, realpathSync as realpathSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3, resolve as resolve2, sep } from "node:path";

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
    const sep2 = path.includes("?") ? "&" : "?";
    for (let page = 1; page < 100; page++) {
      const items = await this.req("GET", `${path}${sep2}limit=50&page=${page}`);
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

// src/mcp/shell.ts
var PREFIXES = /* @__PURE__ */ new Set([
  "!",
  "{",
  "}",
  "then",
  "do",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "time",
  "command",
  "builtin",
  "exec",
  "nohup",
  "env",
  "sudo"
]);
var SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash"]);
var ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
var REDIRECT = /^(\d*|&)(>>?|<>?|>&|<&)(.*)$/;
function parseCommand(command, depth = 0) {
  const out = [];
  const raws = [];
  let cur = { words: [], quoted: [], heredocs: [], pending: [] };
  const queue = [];
  let word = null;
  let quoted = false;
  const endWord = () => {
    if (word !== null) {
      cur.words.push(word);
      cur.quoted.push(quoted);
    }
    word = null;
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    if (cur.words.length || cur.heredocs.length) raws.push(cur);
    if (cur.pending.length) queue.push(cur);
    cur = { words: [], quoted: [], heredocs: [], pending: [] };
  };
  const add = (s) => {
    word = (word ?? "") + s;
  };
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i];
    if (c === "\n") {
      endCommand();
      i++;
      while (queue.length) {
        const owner = queue[0];
        const h = owner.pending.shift();
        if (!owner.pending.length) queue.shift();
        const lines = [];
        while (i < n) {
          let e = command.indexOf("\n", i);
          if (e < 0) e = n;
          const line = command.slice(i, e);
          i = e + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(line);
        }
        owner.heredocs.push(lines.join("\n"));
      }
      continue;
    }
    if (c === " " || c === "	") {
      endWord();
      i++;
      continue;
    }
    if (c === "#" && word === null) {
      while (i < n && command[i] !== "\n") i++;
      continue;
    }
    if (c === "\\") {
      if (command[i + 1] === "\n") {
        i += 2;
        continue;
      }
      add(command[i + 1] ?? "");
      quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = command.indexOf("'", i + 1);
      add(command.slice(i + 1, e < 0 ? n : e));
      quoted = true;
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\" && '"\\$`\n'.includes(command[j + 1] ?? "")) {
          if (command[j + 1] !== "\n") s += command[j + 1];
          j += 2;
        } else if (command[j] === "$" && command[j + 1] === "(") {
          const e = substitutionEnd(command, j);
          s += command.slice(j, e + 1);
          j = e + 1;
        } else if (command[j] === "`") {
          const e = backquoteEnd(command, j);
          s += command.slice(j, e + 1);
          j = e + 1;
        } else {
          s += command[j];
          j++;
        }
      }
      add(s);
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      const e = substitutionEnd(command, i);
      add(command.slice(i, e + 1));
      i = e + 1;
      continue;
    }
    if (c === "`") {
      const e = backquoteEnd(command, i);
      add(command.slice(i, e + 1));
      i = e + 1;
      continue;
    }
    if (command.startsWith("<<<", i)) {
      endWord();
      add("<<<");
      endWord();
      i += 3;
      continue;
    }
    if (c === "<" && command[i + 1] === "<") {
      endWord();
      let j = i + 2;
      const strip = command[j] === "-";
      if (strip) j++;
      while (command[j] === " " || command[j] === "	") j++;
      const [delim, e] = heredocDelimiter(command, j);
      if (delim) cur.pending.push({ delim, strip });
      i = e;
      continue;
    }
    if (c === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) {
      add(c);
      i++;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      endCommand();
      i++;
      continue;
    }
    add(c);
    i++;
  }
  endCommand();
  for (const h of queue) for (const _ of h.pending) h.heredocs.push("");
  for (const r of raws) {
    const words = [];
    const redirects = [];
    for (let k = 0; k < r.words.length; k++) {
      const w2 = r.words[k];
      if (r.quoted[k]) {
        words.push(w2);
        continue;
      }
      if (w2.startsWith("<<<")) {
        if (w2 === "<<<") k++;
        continue;
      }
      const m = REDIRECT.exec(w2);
      if (m && (m[1] !== "" || w2.startsWith(">") || w2.startsWith("<"))) {
        if (m[3] === "" && !/&$/.test(m[2])) {
          if (r.words[k + 1] !== void 0) redirects.push(r.words[k + 1]);
          k++;
        } else if (m[3] && !m[3].startsWith("&")) {
          redirects.push(m[3]);
        }
        continue;
      }
      words.push(w2);
    }
    let s = 0;
    while (s < words.length && (ASSIGNMENT.test(words[s]) || PREFIXES.has(words[s]) || words[s] === "-i" && words[s - 1] === "env")) s++;
    const w = words.slice(s);
    if (!w.length && !r.heredocs.length && !redirects.length) continue;
    out.push({ words: w, heredocs: r.heredocs, redirects });
    const exe = (w[0] ?? "").split("/").pop();
    if (SHELLS.has(exe) && depth < 3) {
      const ci = w.findIndex((a, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(a));
      if (ci > 0 && w[ci + 1] !== void 0) out.push(...parseCommand(w[ci + 1], depth + 1));
      else for (const h of r.heredocs) out.push(...parseCommand(h, depth + 1));
    }
  }
  return out;
}
function heredocDelimiter(command, j) {
  const n = command.length;
  let delim = "";
  while (j < n && !" 	\n;&|<>()".includes(command[j])) {
    const q = command[j];
    if (q === "'" || q === '"') {
      const e = command.indexOf(q, j + 1);
      delim += command.slice(j + 1, e < 0 ? n : e);
      j = e < 0 ? n : e + 1;
    } else {
      if (q !== "\\") delim += q;
      j++;
    }
  }
  return [delim, j];
}
function backquoteEnd(command, i) {
  for (let j = i + 1; j < command.length; j++) {
    if (command[j] === "\\") j++;
    else if (command[j] === "`") return j;
  }
  return command.length - 1;
}
function doubleQuoteEnd(command, i) {
  for (let j = i + 1; j < command.length; j++) {
    const c = command[j];
    if (c === "\\") j++;
    else if (c === '"') return j;
    else if (c === "$" && command[j + 1] === "(") j = substitutionEnd(command, j);
    else if (c === "`") j = backquoteEnd(command, j);
  }
  return command.length - 1;
}
function substitutionEnd(command, i) {
  const n = command.length;
  const pending = [];
  let depth = 0;
  for (let j = i + 1; j < n; j++) {
    const c = command[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "'") {
      const e = command.indexOf("'", j + 1);
      if (e < 0) return n - 1;
      j = e;
      continue;
    }
    if (c === '"') {
      j = doubleQuoteEnd(command, j);
      continue;
    }
    if (c === "`") {
      j = backquoteEnd(command, j);
      continue;
    }
    if (c === "#" && /[\s(;&|]/.test(command[j - 1] ?? " ")) {
      while (j + 1 < n && command[j + 1] !== "\n") j++;
      continue;
    }
    if (c === "<" && command[j + 1] === "<" && command[j + 2] !== "<") {
      let k = j + 2;
      const strip = command[k] === "-";
      if (strip) k++;
      while (command[k] === " " || command[k] === "	") k++;
      const [delim, e] = heredocDelimiter(command, k);
      if (delim) pending.push({ delim, strip });
      j = e - 1;
      continue;
    }
    if (c === "<" && command.startsWith("<<<", j)) {
      j += 2;
      continue;
    }
    if (c === "\n" && pending.length) {
      let k = j + 1;
      for (const h of pending.splice(0)) {
        while (k < n) {
          let e = command.indexOf("\n", k);
          if (e < 0) e = n;
          const line = command.slice(k, e);
          k = e + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        }
      }
      j = k - 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return n - 1;
}

// src/mcp/start-task.ts
import { join as join2 } from "node:path";
var WORKTREES_DIR = join2(".slipway", "worktrees");

// src/mcp/hook.ts
var ALLOW = { action: "allow" };
var GH_PR_PUBLISH = /* @__PURE__ */ new Set(["create", "ready", "merge"]);
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
function firstPositional(args, optsWithValue) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (optsWithValue.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}
var ghApiEndpoint = (w) => firstPositional(w.slice(2), GH_API_OPTS_WITH_VALUE);
function readGraphql(doc) {
  let text = "";
  let depth = 0;
  let mutation = false;
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i];
    if (c === "#") {
      while (i + 1 < doc.length && doc[i + 1] !== "\n") i++;
      text += " ";
      continue;
    }
    if (c === '"') {
      const block = doc.startsWith('"""', i);
      const end = block ? doc.indexOf('"""', i + 3) : (() => {
        for (let j = i + 1; j < doc.length; j++) {
          if (doc[j] === "\\") j++;
          else if (doc[j] === '"' || doc[j] === "\n") return j;
        }
        return -1;
      })();
      i = end < 0 ? doc.length : end + (block ? 2 : 0);
      text += '""';
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[A-Za-z_]/.test(c) && !/[\w$]/.test(doc[i - 1] ?? "")) {
      const word = /^[A-Za-z_]\w*/.exec(doc.slice(i))[0];
      if (word === "mutation") mutation = true;
      text += word;
      i += word.length - 1;
      continue;
    }
    text += c;
  }
  return { text, mutation };
}
function graphqlDocument(source) {
  try {
    const j = JSON.parse(source);
    if (j && typeof j === "object" && typeof j.query === "string") return j.query;
  } catch {
  }
  return source;
}
var PUBLISH_MUTATIONS = /* @__PURE__ */ new Set([
  "createPullRequest",
  "mergePullRequest",
  "markPullRequestReadyForReview",
  "enablePullRequestAutoMerge",
  "enqueuePullRequest",
  "revertPullRequest",
  "updatePullRequestBranch",
  "mergeBranch",
  "createCommitOnBranch",
  "createRef",
  "updateRef",
  "updateRefs"
]);
function graphqlPublishes(cmd, cwd) {
  const w = cmd.words;
  const sources = [];
  const files = [];
  let stdin = false;
  for (let i = 2; i < w.length; i++) {
    const a = w[i];
    let input = null;
    if (a === "--input") input = w[++i] ?? "";
    else if (a.startsWith("--input=")) input = a.slice("--input=".length);
    if (input !== null) {
      if (input === "-") stdin = true;
      else files.push(input);
      continue;
    }
    let field = null;
    if (["-f", "-F", "--field", "--raw-field"].includes(a)) field = w[++i] ?? "";
    else if (/^--(raw-)?field=/.test(a)) field = a.slice(a.indexOf("=") + 1);
    if (field === null || !field.startsWith("query=")) continue;
    const value = field.slice("query=".length);
    if (a !== "-f" && a !== "--raw-field" && !a.startsWith("--raw-field=") && value.startsWith("@")) {
      if (value === "@-") stdin = true;
      else files.push(value.slice(1));
    } else {
      sources.push(value);
    }
  }
  if (stdin) sources.push(...cmd.heredocs);
  for (const f of files) {
    try {
      sources.push(readFileSync2(resolve2(cwd, f.replace(/^~(?=\/)/, homedir2())), "utf8"));
    } catch {
      return true;
    }
  }
  for (const source of sources) {
    const { text, mutation } = readGraphql(graphqlDocument(source));
    if (!mutation) continue;
    const names = [...text.matchAll(/\b([A-Za-z_]\w*)\s*\(\s*input\s*:/g)].map((m) => m[1]);
    if (names.length === 0 || names.some((n) => PUBLISH_MUTATIONS.has(n))) return true;
  }
  return false;
}
function ghApiMethod(w) {
  let fields = false;
  for (let i = 2; i < w.length; i++) {
    const a = w[i];
    if (a === "-X" || a === "--method") return (w[i + 1] ?? "").toUpperCase();
    const m = /^(?:-X|--method=)([A-Za-z]+)$/.exec(a);
    if (m) return m[1].toUpperCase();
    if (["-f", "-F", "--field", "--raw-field", "--input"].includes(a) || /^--(raw-)?field=/.test(a)) fields = true;
  }
  return fields ? "POST" : "GET";
}
function restPublishes(endpoint, method) {
  if (method === "GET" || method === "HEAD") return false;
  const path = endpoint.replace(/^\/+/, "").replace(/\?.*$/, "");
  const m = /^repos\/[^/]+\/[^/]+\/(.*)$/.exec(path);
  if (!m) return false;
  const rest = m[1].replace(/\/+$/, "");
  if (rest === "pulls") return method === "POST";
  return /^(pulls\/\d+\/(merge|update-branch)|merges|git\/refs(\/.*)?|contents\/.+)$/.test(rest);
}
function ghApiField(w, name) {
  for (let i = 2; i < w.length; i++) {
    const a = w[i];
    let field;
    if (["-f", "-F", "--field", "--raw-field"].includes(a)) field = w[++i];
    else if (/^--(raw-)?field=/.test(a)) field = a.slice(a.indexOf("=") + 1);
    if (field?.startsWith(name + "=")) return field.slice(name.length + 1);
  }
  return null;
}
var stripOwner = (head) => head.slice(head.indexOf(":") + 1) || null;
function ghApiPublishes(cmd, cwd) {
  const w = cmd.words;
  const endpoint = ghApiEndpoint(w);
  if (endpoint === "graphql") return graphqlPublishes(cmd, cwd) ? { branch: "current" } : null;
  const method = ghApiMethod(w);
  if (endpoint === null || !restPublishes(endpoint, method)) return null;
  const m = /^\/?repos\/([^/]+)\/([^/]+)\/(.*?)\/*(?:\?.*)?$/.exec(endpoint);
  if (!m) return null;
  const [, owner, repo, rest] = m;
  const pull = /^pulls\/(\d+)\/(merge|update-branch)$/.exec(rest);
  if (pull) return { pr: owner === "{owner}" && repo === "{repo}" ? pull[1] : `https://github.com/${owner}/${repo}/pull/${pull[1]}` };
  if (rest === "pulls") {
    const head = ghApiField(w, "head");
    if (head === null) return { branch: "current" };
    const branch = stripOwner(head);
    return branch ? { branch } : { unknown: "a PR without a head branch" };
  }
  if (rest === "merges") {
    const head = ghApiField(w, "head");
    return head ? { branch: head } : { unknown: "a merge without a head branch" };
  }
  if (rest.startsWith("contents/")) {
    const branch = ghApiField(w, "branch");
    return branch ? { branch } : { unknown: "a file write to the default branch" };
  }
  const ref = rest === "git/refs" ? ghApiField(w, "ref") ?? "" : /^git\/refs\/(.+)$/.exec(rest)?.[1] ?? null;
  if (ref !== null) {
    const name = ref.replace(/^refs\//, "");
    if (!name.startsWith("heads/")) return { unknown: `a write to the ref "${name || "?"}"` };
    return { branch: name.slice("heads/".length), deleting: method === "DELETE" };
  }
  return null;
}
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
    positional.push(a);
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
var ghPrSelector = (args) => firstPositional(args, GH_PR_OPTS_WITH_VALUE);
function ghCreateHead(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-H" || a === "--head") return stripOwner(args[i + 1] ?? "");
    if (a.startsWith("--head=")) return stripOwner(a.slice("--head=".length));
  }
  return null;
}
var pushRemote = (args) => firstPositional(args, PUSH_OPTS_WITH_VALUE);
var PUSH_HINT = "push with the slipway_push tool (it pushes to the local review Gitea); GitHub gets the branch through promotion";
var ASK_TAIL = "Allow it only if you want it on GitHub without the local review.";
async function judgeBranch(branch, what, env, opts = {}) {
  if (!branch) {
    return { action: "ask", reason: `Slipway: cannot tell which branch ${what} targets (detached HEAD, or an unknown PR?). ${ASK_TAIL}` };
  }
  let state;
  try {
    state = await env.branchState(branch);
  } catch {
    return { action: "ask", reason: `Slipway could not check the Slipway PR for "${branch}" (is it running? \`slipway up\`). ${ASK_TAIL}` };
  }
  if (state === "closed") return ALLOW;
  if (opts.deleting) return { action: "ask", reason: `Slipway: ${what} deletes "${branch}" on GitHub. Allow it only if that branch is no longer needed there.` };
  if (state === "open") {
    return { action: "deny", reason: `Slipway: "${branch}" has an open Slipway PR, so ${what} must go through Slipway first: ${PUSH_HINT} (slipway_push, slipway_update_pr, slipway_promote).` };
  }
  if (branch === env.currentBranch() && env.inTaskWorktree()) {
    return { action: "deny", reason: `Slipway: "${branch}" is this task's branch and has no Slipway PR yet, so ${what} would skip the local review: ${PUSH_HINT}, then slipway_open_pr.` };
  }
  return { action: "ask", reason: `Slipway: "${branch}" has no Slipway PR, so ${what} publishes it on GitHub without the local review. ${ASK_TAIL}` };
}
var CREDENTIAL_PATH = /[^\s'"`;|&<>(),=@:]*(?:config\.json|app\.ini|secrets\.json|gitea\.env)(?![\w.-])/g;
var expandHome = (p) => p.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir2());
function readsCredentials(cmds, cwd, env) {
  const files = new Set(env.credentialFiles().flatMap((f) => [f, realOrSelf(f)]));
  let dir = cwd;
  for (const c of cmds) {
    if (c.words[0] === "cd" && !c.words.includes("-")) {
      const to = c.words.slice(1).find((a) => !a.startsWith("-"));
      if (to === void 0) dir = homedir2();
      else if (!to.includes("$(") && !to.includes("`")) dir = resolve2(dir, expandHome(to));
    }
    for (const w of [...c.words, ...c.redirects]) {
      for (const [p] of w.matchAll(CREDENTIAL_PATH)) {
        const abs = resolve2(dir, expandHome(p));
        if (files.has(abs) || files.has(realOrSelf(abs))) return true;
      }
    }
  }
  return false;
}
function realOrSelf(p) {
  try {
    return realpathSync2(p);
  } catch {
    return p;
  }
}
async function judgeCommand(c, cwd, env) {
  const w = c.words;
  const exe = (w[0] ?? "").split("/").pop();
  if (w[0] === "git") {
    const i = gitSubcommandIndex(w);
    if (i < 0 || w[i] !== "push") return ALLOW;
    const args = w.slice(i + 1);
    if (args.includes("-n") || args.includes("--dry-run")) return ALLOW;
    if (!await env.pushesToGitHub(pushRemote(args)).catch(() => true)) return ALLOW;
    const branches = pushedBranches(args);
    if (branches === "all") {
      return { action: "ask", reason: `Slipway: this push publishes tags or several branches at once, which no Slipway PR covers. ${ASK_TAIL}` };
    }
    const deleting = args.includes("-d") || args.includes("--delete") || args.some((a) => /^\+?:/.test(a));
    let ask = null;
    for (const b of branches) {
      const d = await judgeBranch(b ?? env.currentBranch(), deleting ? "this push" : "pushing it", env, { deleting });
      if (d.action === "deny") return d;
      if (d.action === "ask") ask ??= d;
    }
    return ask ?? ALLOW;
  }
  if (exe === "slipway" && w[1] === "promote" || exe === "promote.sh") {
    return { action: "deny", reason: "Slipway: promotion from the shell is for the user. Use the slipway_promote tool (it requires the user's approval)." };
  }
  if (w[0] === "gh" && w[1] === "pr" && GH_PR_PUBLISH.has(w[2] ?? "")) {
    const args = w.slice(3);
    let branch;
    if (w[2] === "create") {
      branch = ghCreateHead(args) ?? env.currentBranch();
    } else {
      const sel = ghPrSelector(args);
      branch = sel === null ? env.currentBranch() : await env.githubPrHead(sel).catch(() => null);
    }
    return judgeBranch(branch, `"gh pr ${w[2]}"`, env);
  }
  if (w[0] === "gh" && w[1] === "api") {
    const p = ghApiPublishes(c, cwd);
    if (!p) return ALLOW;
    const what = 'this "gh api" call';
    if ("unknown" in p) return { action: "ask", reason: `Slipway: ${what} is ${p.unknown}, which no Slipway PR covers. ${ASK_TAIL}` };
    if ("pr" in p) return judgeBranch(await env.githubPrHead(p.pr).catch(() => null), what, env);
    return judgeBranch(p.branch === "current" ? env.currentBranch() : p.branch, what, env, { deleting: p.deleting });
  }
  return ALLOW;
}
async function decide(input, env) {
  if (input.tool_name !== "Bash") return ALLOW;
  const command = input.tool_input.command ?? "";
  if (!command || !env.isRegistered(input.cwd)) return ALLOW;
  const cmds = parseCommand(command);
  if (readsCredentials(cmds, input.cwd, env)) {
    return { action: "deny", reason: "Slipway: do not read Slipway credentials. Use the slipway_* tools instead." };
  }
  let ask = null;
  for (const c of cmds) {
    const d = await judgeCommand(c, input.cwd, env);
    if (d.action === "deny") return d;
    if (d.action === "ask") ask ??= d;
  }
  return ask ?? ALLOW;
}
function hookEnv(config, repo) {
  const token = config.claude?.token ?? config.reviewer.token;
  const gitea = new GiteaClient(config.giteaUrl, token, (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5e3) }));
  let states;
  const git2 = async (...args) => {
    const r = await run("git", args, { cwd: repo.worktree, timeoutMs: 5e3 });
    return r.code === 0 ? r.stdout.trim() || null : null;
  };
  const tasks = realOrSelf(join3(repo.entry.path, WORKTREES_DIR)) + sep;
  return {
    isRegistered: () => true,
    currentBranch: () => repo.branch,
    inTaskWorktree: () => (realOrSelf(repo.worktree) + sep).startsWith(tasks),
    async branchState(branch) {
      states ??= gitea.listPulls(config.org, repo.name, "all").then((pulls) => {
        const m = /* @__PURE__ */ new Map();
        for (const p of pulls) if (m.get(p.head.ref) !== "open") m.set(p.head.ref, p.state === "open" ? "open" : "closed");
        return m;
      });
      return (await states).get(branch) ?? "none";
    },
    async githubPrHead(ref) {
      const r = await run("gh", ["pr", "view", ref, "--json", "headRefName", "-q", ".headRefName"], { cwd: repo.worktree, timeoutMs: 15e3 });
      return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
    async pushesToGitHub(remote) {
      let name = remote;
      if (name === null) {
        const cfg = /* @__PURE__ */ new Map();
        for (const entry of (await git2("config", "-z", "--list") ?? "").split("\0")) {
          const nl = entry.indexOf("\n");
          if (nl > 0) cfg.set(entry.slice(0, nl), entry.slice(nl + 1));
        }
        const b = repo.branch;
        name = b && cfg.get(`branch.${b}.pushremote`) || cfg.get("remote.pushdefault") || b && cfg.get(`branch.${b}.remote`) || "origin";
      }
      if (name === "origin") return true;
      const url = /[:/]/.test(name) ? name : await git2("remote", "get-url", "--push", name);
      if (url === null) return true;
      return /github/i.test(url) || url === await git2("remote", "get-url", "--push", "origin");
    },
    credentialFiles: () => {
      const home = slipwayHome();
      return [join3(home, "config.json"), join3(home, "gitea", "app.ini"), join3(home, "gitea", "secrets.json"), join3(home, "docker", "gitea.env")];
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
  if (d.action === "deny") {
    process.stderr.write(d.reason + "\n");
    process.exit(2);
  }
  if (d.action === "ask") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: d.reason } }) + "\n");
  }
}

// src/mcp/entry-hook.ts
main().catch(() => process.exit(0));
