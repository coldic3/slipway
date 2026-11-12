/** Review feedback Claude still has to address. Empty path = general feedback (a review summary). */
export interface UnresolvedComment {
  id: number;
  path: string;
  line: number;
  body: string;
  author: string;
  diffHunk: string;
}

export interface GUser { id?: number; login: string }
export interface GLabel { id: number; name: string; color?: string }

export interface GPull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  html_url: string;
  user: GUser;
  labels: GLabel[];
  head: { ref: string; sha: string };
  base: { ref: string; sha?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  created_at?: string;
}

export interface GCommit { sha: string; commit: { message: string; author?: { name: string; date?: string } } }
export interface GFile { filename: string; status: string; additions: number; deletions: number; previous_filename?: string }
export interface GTimelineEvent {
  id?: number;
  type: string;
  created_at: string;
  user?: GUser | null;
  body?: string;
  old_ref?: string;
  new_ref?: string;
  review_id?: number;
}

export interface GReview {
  id: number;
  state: 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT' | 'PENDING' | 'REQUEST_REVIEW' | string;
  body: string;
  dismissed: boolean;
  stale?: boolean;
  user: GUser | null;
  submitted_at: string;
  commit_id?: string;
}

export interface GReviewComment {
  id: number;
  path: string;
  position: number;
  original_position: number;
  body: string;
  diff_hunk: string;
  resolver: GUser | null;
  user: GUser;
  pull_request_review_id?: number;
  html_url?: string;
  created_at?: string;
}

export interface GComment { id: number; body: string; user: GUser; created_at: string; html_url?: string }

export interface GRepo {
  id: number;
  name: string;
  full_name: string;
  owner: GUser;
  default_branch: string;
  clone_url: string;
  html_url: string;
  allow_merge_commits: boolean;
  allow_rebase: boolean;
  allow_rebase_explicit: boolean;
  allow_squash_merge: boolean;
  allow_fast_forward_only_merge?: boolean;
  allow_manual_merge?: boolean;
}

export interface GHook { id: number; type: string; config: Record<string, string>; events: string[]; active: boolean }
