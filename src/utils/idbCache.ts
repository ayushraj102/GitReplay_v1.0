import { AIAnalysisResult, FileSnapshot } from '../types/git';

export const PROMPT_VERSION = 'v1';

const DB_NAME = 'gitreplay_cache_v1';
const DB_VERSION = 1;
const STORE_AI_CACHE = 'aiCache';
const STORE_CHAT_THREADS = 'chatThreads';
const STORE_COMMIT_DIFFS = 'commitDiffs';

export type AICacheMode = 'analysis' | 'ask';

export interface CachedAIEntry {
  cacheId: string;
  repoId: string;
  commitSha: string;
  mode: AICacheMode;
  model: string;
  promptVersion: string;
  normalizedQuestion: string;
  responseText?: string;
  analysisData?: AIAnalysisResult;
  updatedAtMs: number;
}

export interface StoredChatMessage {
  id: string;
  repoId: string;
  commitSha: string;
  role: 'user' | 'model';
  persona: 'general' | 'architect' | 'mentor' | 'fast';
  modelUsed: string;
  text: string;
  createdAtMs: number;
  fromCache?: boolean;
  cacheQuestion?: string;
}

interface StoredChatThread {
  threadId: string;
  repoId: string;
  commitSha: string;
  messages: StoredChatMessage[];
  updatedAtMs: number;
}

interface StoredCommitDiff {
  diffKey: string;
  owner: string;
  repo: string;
  sha: string;
  files: FileSnapshot[];
  updatedAtMs: number;
}

export function normalizeQuestion(question: string): string {
  return (question || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function fnv1aHex(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function buildAICacheId(params: {
  repoId: string;
  commitSha: string;
  mode: AICacheMode;
  model: string;
  promptVersion?: string;
  question?: string;
}): string {
  const pv = params.promptVersion || PROMPT_VERSION;
  const normQ = normalizeQuestion(params.question || '');
  const rawKey = `${params.repoId}::${params.commitSha}::${params.mode}::${params.model}::${pv}::${normQ}`;
  const h1 = fnv1aHex(rawKey, 0x811c9dc5);
  const h2 = fnv1aHex(rawKey.split('').reverse().join(''), 0x9e3779b9);
  const safePrefix = params.mode === 'analysis' ? 'ana' : 'ask';
  return `gr_${safePrefix}_${h1}${h2}`;
}

export function emitCacheUpdatedEvent(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('gitreplay-cache-updated'));
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_AI_CACHE)) {
          db.createObjectStore(STORE_AI_CACHE, { keyPath: 'cacheId' });
        }
        if (!db.objectStoreNames.contains(STORE_CHAT_THREADS)) {
          db.createObjectStore(STORE_CHAT_THREADS, { keyPath: 'threadId' });
        }
        if (!db.objectStoreNames.contains(STORE_COMMIT_DIFFS)) {
          db.createObjectStore(STORE_COMMIT_DIFFS, { keyPath: 'diffKey' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        resolve(null);
      };
      request.onblocked = () => {
        dbPromise = null;
        resolve(null);
      };
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });

  return dbPromise;
}

export async function getCachedAIResponse(cacheId: string): Promise<CachedAIEntry | null> {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_AI_CACHE, 'readonly');
      const store = tx.objectStore(STORE_AI_CACHE);
      const req = store.get(cacheId);
      req.onsuccess = () => resolve((req.result as CachedAIEntry) || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setCachedAIResponse(entry: CachedAIEntry): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_AI_CACHE, 'readwrite');
      const store = tx.objectStore(STORE_AI_CACHE);
      store.put(entry);
      tx.oncomplete = () => {
        emitCacheUpdatedEvent();
        resolve();
      };
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function countCachedAIResponses(): Promise<number> {
  const db = await openDB();
  if (!db) return 0;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_AI_CACHE, 'readonly');
      const req = tx.objectStore(STORE_AI_CACHE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

export async function clearAllAICache(): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_AI_CACHE, 'readwrite');
      tx.objectStore(STORE_AI_CACHE).clear();
      tx.oncomplete = () => {
        emitCacheUpdatedEvent();
        resolve();
      };
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function buildThreadId(repoId: string, commitSha: string): string {
  return `${repoId}::${commitSha}`;
}

export async function getLocalChatThread(
  repoId: string,
  commitSha: string
): Promise<StoredChatMessage[]> {
  const db = await openDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_CHAT_THREADS, 'readonly');
      const req = tx.objectStore(STORE_CHAT_THREADS).get(buildThreadId(repoId, commitSha));
      req.onsuccess = () => {
        const res = req.result as StoredChatThread | undefined;
        resolve(Array.isArray(res?.messages) ? res.messages : []);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function saveLocalChatThread(
  repoId: string,
  commitSha: string,
  messages: StoredChatMessage[]
): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_CHAT_THREADS, 'readwrite');
      const record: StoredChatThread = {
        threadId: buildThreadId(repoId, commitSha),
        repoId,
        commitSha,
        messages,
        updatedAtMs: Date.now(),
      };
      tx.objectStore(STORE_CHAT_THREADS).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearLocalChatThread(
  repoId: string,
  commitSha: string
): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_CHAT_THREADS, 'readwrite');
      tx.objectStore(STORE_CHAT_THREADS).delete(buildThreadId(repoId, commitSha));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function buildDiffKey(owner: string, repo: string, sha: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}@${sha}`;
}

export async function getCachedCommitDiff(
  owner: string,
  repo: string,
  sha: string
): Promise<FileSnapshot[] | null> {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_COMMIT_DIFFS, 'readonly');
      const req = tx.objectStore(STORE_COMMIT_DIFFS).get(buildDiffKey(owner, repo, sha));
      req.onsuccess = () => {
        const res = req.result as StoredCommitDiff | undefined;
        resolve(res?.files || null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setCachedCommitDiff(
  owner: string,
  repo: string,
  sha: string,
  files: FileSnapshot[]
): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_COMMIT_DIFFS, 'readwrite');
      const record: StoredCommitDiff = {
        diffKey: buildDiffKey(owner, repo, sha),
        owner,
        repo,
        sha,
        files,
        updatedAtMs: Date.now(),
      };
      tx.objectStore(STORE_COMMIT_DIFFS).put(record);
      tx.oncomplete = () => {
        emitCacheUpdatedEvent();
        resolve();
      };
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function countCachedCommitDiffs(): Promise<number> {
  const db = await openDB();
  if (!db) return 0;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_COMMIT_DIFFS, 'readonly');
      const req = tx.objectStore(STORE_COMMIT_DIFFS).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

export async function clearCommitDiffCache(): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_COMMIT_DIFFS, 'readwrite');
      tx.objectStore(STORE_COMMIT_DIFFS).clear();
      tx.oncomplete = () => {
        emitCacheUpdatedEvent();
        resolve();
      };
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
