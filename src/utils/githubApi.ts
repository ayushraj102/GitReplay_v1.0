import { FileSnapshot, GitCommit, GitHubRepoMeta } from '../types/git';
import { inferCommitCategory, inferModuleLayer } from './gitEngine';
import { getCachedCommitDiff, setCachedCommitDiff } from './idbCache';

const GITHUB_TOKEN_STORAGE_KEY = 'gitreplay_github_token_v1';

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAtMs: number;
  updatedAtMs: number;
}

let lastRateLimit: RateLimitInfo | null = null;
const rateLimitListeners = new Set<(info: RateLimitInfo | null) => void>();

export function getGitHubToken(): string {
  try {
    return typeof localStorage !== 'undefined'
      ? localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || ''
      : '';
  } catch {
    return '';
  }
}

export function setGitHubToken(token: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const trimmed = token.trim();
    if (trimmed) {
      localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function clearGitHubToken(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore
  }
}

export function getLastRateLimitInfo(): RateLimitInfo | null {
  return lastRateLimit;
}

export function subscribeRateLimit(
  listener: (info: RateLimitInfo | null) => void
): () => void {
  rateLimitListeners.add(listener);
  listener(lastRateLimit);
  return () => {
    rateLimitListeners.delete(listener);
  };
}

function updateRateLimitFromHeaders(headers: Headers): RateLimitInfo | null {
  const limitRaw = headers.get('X-RateLimit-Limit');
  const remainingRaw = headers.get('X-RateLimit-Remaining');
  const resetRaw = headers.get('X-RateLimit-Reset');
  if (limitRaw == null || remainingRaw == null || resetRaw == null) {
    return lastRateLimit;
  }
  const limit = Number(limitRaw);
  const remaining = Number(remainingRaw);
  const resetAtMs = Number(resetRaw) * 1000;
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(resetAtMs)) {
    return lastRateLimit;
  }
  lastRateLimit = {
    limit,
    remaining,
    resetAtMs,
    updatedAtMs: Date.now(),
  };
  rateLimitListeners.forEach((cb) => cb(lastRateLimit));
  return lastRateLimit;
}

export function formatRetryTime(resetAtMs: number): string {
  const now = Date.now();
  const diffSec = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  const timeStr = new Date(resetAtMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (mins > 0) {
    return `${timeStr} (in ${mins}m ${secs}s)`;
  }
  return `${timeStr} (in ${secs}s)`;
}

export class GitHubRateLimitError extends Error {
  resetAtMs: number;
  remaining: number;
  limit: number;

  constructor(message: string, resetAtMs: number, remaining: number, limit: number) {
    super(message);
    this.name = 'GitHubRateLimitError';
    this.resetAtMs = resetAtMs;
    this.remaining = remaining;
    this.limit = limit;
  }
}

async function githubFetch(url: string): Promise<Response> {
  const token = getGitHubToken();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('GitHub API request timed out after 25s. Please try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  const rateInfo = updateRateLimitFromHeaders(res.headers);

  if (
    (res.status === 403 || res.status === 429) &&
    rateInfo &&
    rateInfo.remaining === 0
  ) {
    const retryText = formatRetryTime(rateInfo.resetAtMs);
    throw new GitHubRateLimitError(
      `GitHub API rate limit reached (0/${rateInfo.limit} remaining). Try again at ${retryText}, or add a personal GitHub token in settings to increase your limit.`,
      rateInfo.resetAtMs,
      rateInfo.remaining,
      rateInfo.limit
    );
  }

  if (!res.ok) {
    let apiMessage = '';
    try {
      const body = await res.json();
      if (body?.message) apiMessage = body.message;
    } catch {
      // Ignore parse errors
    }
    if (res.status === 403 && apiMessage.toLowerCase().includes('rate limit')) {
      const resetMs = rateInfo?.resetAtMs || Date.now() + 15 * 60 * 1000;
      throw new GitHubRateLimitError(
        `GitHub API rate limit exceeded. Try again at ${formatRetryTime(resetMs)} or add a GitHub token.`,
        resetMs,
        0,
        rateInfo?.limit || 60
      );
    }
    if (res.status === 404) {
      throw new Error(
        `Repository or ref not found (${apiMessage || '404'}). Check the owner/repo slug, branch/tag filter, or provide a GitHub token for private repositories.`
      );
    }
    if (res.status === 401) {
      throw new Error('GitHub token was rejected (401 Unauthorized). Check or clear your saved token.');
    }
    throw new Error(apiMessage || `GitHub API returned ${res.status}.`);
  }

  return res;
}

export function parseGitHubSlug(input: string): { owner: string; repo: string } | null {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\/$/, '')
    .replace(/\.git$/i, '');

  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0].trim(), repo: parts[1].trim() };
}

function inferLanguageFromPath(filePath: string): FileSnapshot['language'] {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'json';
  return 'typescript';
}

function buildLightweightCommit(
  raw: any,
  tagMap: Map<string, string>,
  owner: string,
  repo: string
): GitCommit {
  const sha: string = raw.sha;
  const shortSha = sha.slice(0, 7);
  const fullMessage: string = raw.commit?.message || `Commit ${shortSha}`;
  const lines = fullMessage.split('\n').filter((l: string) => l.trim().length > 0);
  const title = lines[0] || `Commit ${shortSha}`;
  const body = lines.slice(1).join(' ') || title;
  const category = inferCommitCategory(fullMessage);
  const tag = tagMap.get(sha);
  const timestamp = (raw.commit?.author?.date || raw.commit?.committer?.date || new Date().toISOString())
    .slice(0, 19)
    .replace('T', ' ');

  return {
    sha,
    shortSha,
    parentSha: raw.parents?.[0]?.sha || null,
    branch: 'main',
    tag,
    title,
    message: body,
    author: raw.commit?.author?.name || raw.author?.login || 'Contributor',
    authorRole: 'Repository Maintainer',
    timestamp,
    relativeTime: shortSha,
    category,
    isArchitecturalMilestone: Boolean(tag) || category === 'Architecture' || category === 'Performance',
    files: [],
    diffLoaded: false,
    adr: {
      id: `ADR-${shortSha.toUpperCase()}`,
      title,
      problemStatement: body,
      decisionSummary: `${title} in ${owner}/${repo} (${shortSha}).`,
      tradeoffs: ['Open this commit to inspect changed files and diffs lazily.'],
      measurableOutcome: tag ? `Release tag ${tag}` : `Commit ${shortSha}`,
      modules: [
        {
          id: `mod-${shortSha}`,
          name: `${repo} module`,
          layer: 'core',
          description: title.slice(0, 80),
          status: 'modified',
        },
      ],
      edges: [],
    },
  };
}

export interface FetchGitHubPageParams {
  owner: string;
  repo: string;
  targetCount: number;
  page?: number;
  filterPath?: string;
  since?: string;
  until?: string;
  tagFrom?: string;
  tagTo?: string;
  milestonesOnly?: boolean;
}

export interface FetchGitHubPageResult {
  description: string;
  defaultBranch: string;
  primaryLanguage: string;
  commits: GitCommit[];
  githubMeta: GitHubRepoMeta;
}

export async function fetchGitHubCommitPage(
  params: FetchGitHubPageParams
): Promise<FetchGitHubPageResult> {
  const {
    owner,
    repo,
    targetCount,
    page = 1,
    filterPath,
    since,
    until,
    tagFrom,
    tagTo,
    milestonesOnly,
  } = params;

  const clampedTarget = Math.max(1, Math.min(200, Math.round(targetCount)));

  // Fetch repo metadata (only on initial page or best-effort) and tags map in parallel
  const [repoInfoResp, tagsResp] = await Promise.all([
    page === 1
      ? githubFetch(`https://api.github.com/repos/${owner}/${repo}`).catch(() => null)
      : Promise.resolve(null),
    githubFetch(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=100`).catch(() => null),
  ]);

  let description = `Live imported commit timeline from GitHub (${owner}/${repo}).`;
  let defaultBranch = 'main';
  let primaryLanguage = 'TypeScript';

  if (repoInfoResp) {
    const info = await repoInfoResp.json().catch(() => null);
    if (info) {
      if (info.description) description = info.description;
      if (info.default_branch) defaultBranch = info.default_branch;
      if (info.language) primaryLanguage = info.language;
    }
  }

  const tagMap = new Map<string, string>();
  const orderedTagShas: Array<{ name: string; sha: string }> = [];
  if (tagsResp) {
    const tagsData = await tagsResp.json().catch(() => []);
    if (Array.isArray(tagsData)) {
      for (const t of tagsData) {
        if (t?.commit?.sha && t?.name) {
          if (!tagMap.has(t.commit.sha)) {
            tagMap.set(t.commit.sha, t.name);
          }
          orderedTagShas.push({ name: t.name, sha: t.commit.sha });
        }
      }
    }
  }

  const rawCommitsNewestFirst: any[] = [];
  let nextPage = page;
  let hasMore = false;

  const cleanTagFrom = tagFrom?.trim();
  const cleanTagTo = tagTo?.trim();
  const cleanPath = filterPath?.trim().replace(/^\/+/, '');
  const toSafeIso = (rawDate: string | undefined, suffix: string): string => {
    const trimmed = rawDate?.trim();
    if (!trimmed) return '';
    const d = new Date(`${trimmed}${suffix}`);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  };
  const sinceIso = toSafeIso(since, 'T00:00:00Z');
  const untilIso = toSafeIso(until, 'T23:59:59Z');

  if (cleanTagFrom && cleanTagTo && page === 1) {
    // Use GitHub Compare API for exact tag/release range
    const compareRes = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(
        cleanTagFrom
      )}...${encodeURIComponent(cleanTagTo)}`
    );
    const compareData = await compareRes.json();
    const compared: any[] = Array.isArray(compareData?.commits) ? compareData.commits : [];
    // Compare returns oldest->newest; reverse to newest->oldest so slicing/filtering aligns
    const reversed = [...compared].reverse();
    for (const c of reversed) {
      const dateStr = c.commit?.author?.date || '';
      if (sinceIso && dateStr && dateStr < sinceIso) continue;
      if (untilIso && dateStr && dateStr > untilIso) continue;
      rawCommitsNewestFirst.push(c);
      if (rawCommitsNewestFirst.length >= clampedTarget) break;
    }
    hasMore = false;
  } else {
    // Paginated /commits endpoint with per_page=100
    let remainingNeeded = clampedTarget;
    let currentPage = page;
    const maxPagesToFetch = Math.ceil(clampedTarget / 100) + (milestonesOnly ? 1 : 0);

    for (let p = 0; p < maxPagesToFetch && remainingNeeded > 0; p++) {
      const qs = new URLSearchParams();
      qs.set('per_page', String(Math.min(100, Math.max(milestonesOnly ? 100 : remainingNeeded, 1))));
      qs.set('page', String(currentPage));
      if (cleanPath) qs.set('path', cleanPath);
      if (sinceIso) qs.set('since', sinceIso);
      if (untilIso) qs.set('until', untilIso);
      if (cleanTagTo) qs.set('sha', cleanTagTo);

      const listRes = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/commits?${qs.toString()}`
      );
      const pageData = await listRes.json();
      if (!Array.isArray(pageData) || pageData.length === 0) {
        hasMore = false;
        break;
      }

      for (const item of pageData) {
        if (cleanTagFrom && tagMap.get(item.sha) === cleanTagFrom) {
          rawCommitsNewestFirst.push(item);
          remainingNeeded = 0;
          hasMore = false;
          break;
        }
        rawCommitsNewestFirst.push(item);
        if (!milestonesOnly && rawCommitsNewestFirst.length >= clampedTarget) {
          break;
        }
      }

      const requestedSize = Number(qs.get('per_page'));
      hasMore = pageData.length === requestedSize;
      nextPage = currentPage + 1;
      currentPage += 1;

      if (!hasMore) break;
      if (!milestonesOnly && rawCommitsNewestFirst.length >= clampedTarget) break;
    }
  }

  let selectedRaw = rawCommitsNewestFirst;

  if (milestonesOnly) {
    const taggedMatches = rawCommitsNewestFirst.filter((c) => tagMap.has(c.sha));
    if (taggedMatches.length > 0) {
      selectedRaw = taggedMatches.slice(0, clampedTarget);
    } else if (orderedTagShas.length > 0 && page === 1) {
      // Fetch commit headers for the most recent tags directly when none appeared in recent commits
      let tagsSubset = orderedTagShas;
      if (cleanTagFrom || cleanTagTo) {
        const toIdx = cleanTagTo ? tagsSubset.findIndex((t) => t.name === cleanTagTo) : 0;
        const fromIdx = cleanTagFrom
          ? tagsSubset.findIndex((t) => t.name === cleanTagFrom)
          : tagsSubset.length - 1;
        if (toIdx !== -1 && fromIdx !== -1 && fromIdx >= toIdx) {
          tagsSubset = tagsSubset.slice(toIdx, fromIdx + 1);
        }
      }
      const cap = Math.min(clampedTarget, 20, tagsSubset.length);
      const tagCommitResps = await Promise.all(
        tagsSubset.slice(0, cap).map((t) =>
          githubFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${t.sha}`)
            .then((r) => r.json())
            .catch(() => null)
        )
      );
      selectedRaw = tagCommitResps.filter(Boolean);
      hasMore = false;
    } else {
      selectedRaw = [];
    }
  }

  if (selectedRaw.length === 0) {
    throw new Error(
      milestonesOnly
        ? 'No tagged release/milestone commits matched your filters.'
        : 'No commits matched the repository or filter criteria.'
    );
  }

  // Chronological order: oldest -> newest
  const chronological = [...selectedRaw].reverse();
  const commits = chronological.map((raw, idx) => {
    const c = buildLightweightCommit(raw, tagMap, owner, repo);
    if (idx === 0) c.isArchitecturalMilestone = true;
    c.relativeTime = `Step ${idx + 1} of ${chronological.length}`;
    return c;
  });

  return {
    description,
    defaultBranch,
    primaryLanguage,
    commits,
    githubMeta: {
      owner,
      repo,
      filterPath: cleanPath || undefined,
      since: since?.trim() || undefined,
      until: until?.trim() || undefined,
      tagFrom: cleanTagFrom || undefined,
      tagTo: cleanTagTo || undefined,
      milestonesOnly: Boolean(milestonesOnly),
      nextPage,
      hasMore,
    },
  };
}

function parsePatchToFileSnapshot(f: {
  filename: string;
  patch?: string;
  status?: string;
}): FileSnapshot {
  const patchLines = (f.patch || '').split('\n');
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const pl of patchLines) {
    if (pl.startsWith('@@')) continue;
    if (pl.startsWith('+')) {
      newLines.push(pl.slice(1));
    } else if (pl.startsWith('-')) {
      oldLines.push(pl.slice(1));
    } else {
      const clean = pl.startsWith(' ') ? pl.slice(1) : pl;
      oldLines.push(clean);
      newLines.push(clean);
    }
  }

  const mappedStatus: FileSnapshot['status'] =
    f.status === 'added'
      ? 'added'
      : f.status === 'removed'
      ? 'deleted'
      : 'modified';

  return {
    path: f.filename,
    language: inferLanguageFromPath(f.filename),
    previousContent: oldLines.join('\n'),
    content: newLines.join('\n') || `// ${f.filename} (${f.status || 'modified'})`,
    status: mappedStatus,
  };
}

export async function fetchSingleCommitDiff(
  owner: string,
  repo: string,
  commit: GitCommit
): Promise<{
  files: FileSnapshot[];
  adr: GitCommit['adr'];
  fromCache: boolean;
}> {
  const cachedFiles = await getCachedCommitDiff(owner, repo, commit.sha);
  if (cachedFiles && cachedFiles.length > 0) {
    return {
      files: cachedFiles,
      adr: buildDetailedAdr(commit, owner, repo, cachedFiles),
      fromCache: true,
    };
  }

  const res = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${commit.sha}`);
  const detail = await res.json();

  const rawFiles = Array.isArray(detail?.files) ? detail.files.slice(0, 12) : [];
  const files: FileSnapshot[] = rawFiles.map(parsePatchToFileSnapshot);

  if (files.length === 0) {
    files.push({
      path: 'README.md',
      language: 'typescript',
      previousContent: `# ${repo}`,
      content: `# ${repo}\n\nCommit ${commit.shortSha}: ${commit.title}`,
      status: 'modified',
    });
  }

  await setCachedCommitDiff(owner, repo, commit.sha, files);

  const additions = detail?.stats?.additions ?? 0;
  const deletions = detail?.stats?.deletions ?? 0;
  const adr = buildDetailedAdr(commit, owner, repo, files, additions, deletions);

  return { files, adr, fromCache: false };
}

function buildDetailedAdr(
  commit: GitCommit,
  owner: string,
  repo: string,
  files: FileSnapshot[],
  additions?: number,
  deletions?: number
): GitCommit['adr'] {
  return {
    id: commit.adr?.id || `ADR-${commit.shortSha.toUpperCase()}`,
    title: commit.title,
    problemStatement: commit.message || commit.title,
    decisionSummary: `Updated ${files.length} file(s) in ${owner}/${repo} at commit ${commit.shortSha}.`,
    tradeoffs: files.slice(0, 5).map((f) => `Touched module ${f.path}`),
    measurableOutcome:
      additions !== undefined && deletions !== undefined
        ? `${additions} additions · ${deletions} deletions across ${files.length} file(s)`
        : `${files.length} file(s) changed`,
    modules: files.slice(0, 6).map((f, mIdx) => ({
      id: `gh-mod-${mIdx}`,
      name: f.path.split('/').pop() || f.path,
      layer: inferModuleLayer(f.path),
      description: f.path,
      status: f.status === 'added' ? 'added' : 'modified',
    })),
    edges:
      files.length > 1
        ? [
            {
              from: 'gh-mod-0',
              to: 'gh-mod-1',
              protocol: 'module dependency',
              isNew: true,
            },
          ]
        : [],
  };
}
