/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, ChevronUp } from 'lucide-react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  auth,
  signInWithGoogle,
  signOutUser,
  syncUserProfile,
  saveCommitAnnotation,
  subscribeAnnotations,
  saveUserRepository,
  deleteUserRepository,
  subscribeUserRepositories,
} from './firebase';
import { CURATED_REPOSITORIES } from './data/repositories';
import { GitRepository, GitCommit, CommitCategory } from './types/git';
import { TopBar, MainTab, ThemeMode } from './components/TopBar';
import { OverviewTab } from './components/OverviewTab';
import { TimelineBar, TimelineViewMode } from './components/TimelineBar';
import { CodeViewer } from './components/CodeViewer';
import { CommitInsightPanel } from './components/CommitInsightPanel';
import { ArchitectureView } from './components/ArchitectureView';
import { CommitMatrixTable } from './components/CommitMatrixTable';
import { ImportGitModal } from './components/ImportGitModal';
import { AIArchitectAnalyzer } from './components/AIArchitectAnalyzer';
import { GeminiChatbotPanel } from './components/GeminiChatbotPanel';
import {
  exportOnboardingMarkdown,
  exportOnboardingSummaryPdf,
} from './utils/reportExport';
import { fetchGitHubCommitPage, fetchSingleCommitDiff } from './utils/githubApi';

type AIDrawerTab = 'analyze' | 'chat';

export default function App() {
  // Light / Dark theme preference synced to <html class="dark">
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem('gitreplay_theme_v1');
      return stored === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem('gitreplay_theme_v1', theme);
    } catch {
      // Ignore storage failures
    }
  }, [theme]);

  // Firebase Authentication state
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Repositories state (curated + user-saved Firestore repos)
  const [savedRepos, setSavedRepos] = useState<GitRepository[]>([]);
  const [sessionRepos, setSessionRepos] = useState<GitRepository[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState<boolean>(false);

  const repositories = user
    ? [...savedRepos, ...CURATED_REPOSITORIES]
    : [...sessionRepos, ...CURATED_REPOSITORIES];

  const [activeRepoId, setActiveRepoId] = useState<string>(CURATED_REPOSITORIES[0].id);
  const [activeCommitIndex, setActiveCommitIndex] = useState<number>(0);
  const [baseCommitIndex, setBaseCommitIndex] = useState<number | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string>(
    CURATED_REPOSITORIES[0].commits[0].files[0].path
  );

  // Navigation & View Modes (Default landing = Overview for first-day onboarding)
  const [activeTab, setActiveTab] = useState<MainTab>('overview');
  const [timelineViewMode, setTimelineViewMode] = useState<TimelineViewMode>('diff');

  // Playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [loopPlayback, setLoopPlayback] = useState<boolean>(true);
  const [categoryFilter, setCategoryFilter] = useState<CommitCategory | 'All'>('All');

  // Drawers & Modals (Progressive Disclosure)
  const [importModalState, setImportModalState] = useState<{
    open: boolean;
    initialTab: 'github' | 'raw';
  }>({ open: false, initialTab: 'github' });
  const [aiDrawerState, setAiDrawerState] = useState<{
    open: boolean;
    tab: AIDrawerTab;
  }>({ open: false, tab: 'analyze' });
  const [mobileSheetOpen, setMobileSheetOpen] = useState<boolean>(false);
  const [exportedBanner, setExportedBanner] = useState<boolean>(false);

  // Developer Annotations persisted per commit SHA
  const [annotations, setAnnotations] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem('gitreplay_annotations_v1');
      if (!saved) return {};
      const parsed = JSON.parse(saved);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  });
  const [draftNote, setDraftNote] = useState<string>('');
  const [noteSavedToast, setNoteSavedToast] = useState<boolean>(false);

  // Listen to Firebase Auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      setAuthReady(true);
      if (firebaseUser) {
        try {
          await syncUserProfile(firebaseUser);
        } catch (err) {
          console.error('Profile sync error:', err);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Attach Firestore listeners ONLY when auth is ready and user is authenticated
  useEffect(() => {
    if (!authReady || !user) {
      setSavedRepos([]);
      return;
    }

    setIsLoadingRepos(true);
    const unsubAnnotations = subscribeAnnotations(
      user.uid,
      (cloudNotes) => {
        setAnnotations((prev) => ({ ...prev, ...cloudNotes }));
      },
      (err) => {
        console.error('Annotations listener error:', err);
      }
    );

    const unsubRepos = subscribeUserRepositories(
      user.uid,
      (cloudRepos) => {
        setSavedRepos(cloudRepos);
        setIsLoadingRepos(false);
      },
      (err) => {
        console.error('Saved repos listener error:', err);
        setIsLoadingRepos(false);
      }
    );

    return () => {
      unsubAnnotations();
      unsubRepos();
    };
  }, [authReady, user]);

  const [isLoadingMoreCommits, setIsLoadingMoreCommits] = useState<boolean>(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const inFlightDiffsRef = useRef<Set<string>>(new Set());

  const activeRepo =
    repositories.find((r) => r.id === activeRepoId) || repositories[0];
  const commits = activeRepo.commits;
  const safeCommitIndex = Math.min(activeCommitIndex, Math.max(0, commits.length - 1));
  const activeCommit = commits[safeCommitIndex] || CURATED_REPOSITORIES[0].commits[0];

  const updateRepoInState = useCallback(
    (repoId: string, updater: (repo: GitRepository) => GitRepository) => {
      setSavedRepos((prev) => prev.map((r) => (r.id === repoId ? updater(r) : r)));
      setSessionRepos((prev) => prev.map((r) => (r.id === repoId ? updater(r) : r)));
    },
    []
  );

  const patchCommitInRepo = useCallback(
    (repoId: string, sha: string, patch: Partial<GitCommit>) => {
      updateRepoInState(repoId, (repo) => ({
        ...repo,
        commits: repo.commits.map((c) => (c.sha === sha ? { ...c, ...patch } : c)),
      }));
    },
    [updateRepoInState]
  );

  const loadCommitDiff = useCallback(
    async (repo: GitRepository, targetCommit: GitCommit, showLoadingSpinner: boolean) => {
      const meta = repo.githubMeta;
      if (!meta) return;
      const lockKey = `${repo.id}:${targetCommit.sha}`;
      if (inFlightDiffsRef.current.has(lockKey)) return;
      inFlightDiffsRef.current.add(lockKey);

      if (showLoadingSpinner) {
        patchCommitInRepo(repo.id, targetCommit.sha, {
          diffLoading: true,
          diffError: undefined,
        });
      }

      try {
        const result = await fetchSingleCommitDiff(meta.owner, meta.repo, targetCommit);
        patchCommitInRepo(repo.id, targetCommit.sha, {
          files: result.files,
          adr: result.adr,
          diffLoaded: true,
          diffLoading: false,
          diffError: undefined,
        });
      } catch (err) {
        if (showLoadingSpinner) {
          patchCommitInRepo(repo.id, targetCommit.sha, {
            diffLoading: false,
            diffError:
              err instanceof Error ? err.message : 'Unable to fetch commit diff.',
          });
        }
      } finally {
        inFlightDiffsRef.current.delete(lockKey);
      }
    },
    [patchCommitInRepo]
  );

  // Lazy diff load on commit open + prefetch ONLY the next commit (i + 1)
  useEffect(() => {
    if (!activeRepo.githubMeta || !activeCommit) return;
    if (activeTab !== 'timeline' && activeTab !== 'architecture' && !aiDrawerState.open) {
      return;
    }

    let cancelled = false;
    const run = async () => {
      if (activeCommit.diffLoaded === false && !activeCommit.diffLoading && !activeCommit.diffError) {
        await loadCommitDiff(activeRepo, activeCommit, true);
      }
      if (cancelled) return;
      const nextCommit = commits[safeCommitIndex + 1];
      if (
        nextCommit &&
        nextCommit.diffLoaded === false &&
        !nextCommit.diffLoading &&
        !nextCommit.diffError
      ) {
        loadCommitDiff(activeRepo, nextCommit, false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [
    activeRepo,
    activeCommit,
    commits,
    safeCommitIndex,
    activeTab,
    aiDrawerState.open,
    loadCommitDiff,
  ]);

  const handleLoadMoreCommits = async () => {
    if (!activeRepo.githubMeta || !activeRepo.githubMeta.hasMore || isLoadingMoreCommits) {
      return;
    }
    setPaginationError(null);
    setIsLoadingMoreCommits(true);
    try {
      const meta = activeRepo.githubMeta;
      const res = await fetchGitHubCommitPage({
        owner: meta.owner,
        repo: meta.repo,
        targetCount: 100,
        page: meta.nextPage,
        filterPath: meta.filterPath,
        since: meta.since,
        until: meta.until,
        tagFrom: meta.tagFrom,
        tagTo: meta.tagTo,
        milestonesOnly: meta.milestonesOnly,
      });

      const existingShas = new Set(activeRepo.commits.map((c) => c.sha));
      const olderUnique = res.commits.filter((c) => !existingShas.has(c.sha));
      const mergedCommits = [...olderUnique, ...activeRepo.commits].map((c, idx, arr) => ({
        ...c,
        relativeTime: `Step ${idx + 1} of ${arr.length}`,
      }));

      const updatedRepo: GitRepository = {
        ...activeRepo,
        commits: mergedCommits,
        githubMeta: {
          ...meta,
          nextPage: res.githubMeta.nextPage,
          hasMore: res.githubMeta.hasMore,
        },
      };

      updateRepoInState(activeRepo.id, () => updatedRepo);
      if (olderUnique.length > 0) {
        setActiveCommitIndex((prev) => prev + olderUnique.length);
      }
      if (user) {
        saveUserRepository(user.uid, updatedRepo).catch((err) =>
          console.error('Failed to sync paginated repo:', err)
        );
      }
    } catch (err) {
      setPaginationError(
        err instanceof Error ? err.message : 'Failed to load older commits.'
      );
    } finally {
      setIsLoadingMoreCommits(false);
    }
  };

  // Sync draft note when active commit changes
  useEffect(() => {
    if (activeCommit) {
      setDraftNote(annotations[activeCommit.sha] || '');
    }
  }, [activeCommit, annotations]);

  // Keep selectedFilePath valid if switching commits
  useEffect(() => {
    if (!activeCommit) return;
    const exists = activeCommit.files.some((f) => f.path === selectedFilePath);
    if (!exists && activeCommit.files[0]) {
      setSelectedFilePath(activeCommit.files[0].path);
    }
  }, [activeCommit, selectedFilePath]);

  // Auto-advance timer when timeline playback is running
  useEffect(() => {
    if (!isPlaying) return;
    const intervalMs = Math.round(2600 / playbackSpeed);

    const timer = setInterval(() => {
      setActiveCommitIndex((prev) => {
        if (prev < commits.length - 1) {
          return prev + 1;
        }
        if (loopPlayback) {
          return 0;
        }
        setIsPlaying(false);
        return prev;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isPlaying, playbackSpeed, loopPlayback, commits.length]);

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      setAuthError(err?.message || 'Google sign-in failed.');
    }
  };

  const handleSignOut = async () => {
    setAuthError(null);
    try {
      await signOutUser();
      setActiveRepoId(CURATED_REPOSITORIES[0].id);
      setActiveCommitIndex(0);
    } catch (err: any) {
      setAuthError(err?.message || 'Sign-out failed.');
    }
  };

  const handleSelectRepository = (repoId: string) => {
    setIsPlaying(false);
    setActiveRepoId(repoId);
    setActiveCommitIndex(0);
    setBaseCommitIndex(null);
    const nextRepo = repositories.find((r) => r.id === repoId);
    if (nextRepo && nextRepo.commits[0]?.files[0]) {
      setSelectedFilePath(nextRepo.commits[0].files[0].path);
    }
  };

  const handleDeleteSavedRepo = async (repoId: string) => {
    if (user) {
      try {
        await deleteUserRepository(user.uid, repoId);
      } catch (err) {
        console.error('Failed to delete saved repo:', err);
      }
    } else {
      setSessionRepos((prev) => prev.filter((r) => r.id !== repoId));
    }
    if (activeRepoId === repoId) {
      handleSelectRepository(CURATED_REPOSITORIES[0].id);
    }
  };

  const handleStepPrev = useCallback(() => {
    setIsPlaying(false);
    setActiveCommitIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const handleStepNext = useCallback(() => {
    setIsPlaying(false);
    setActiveCommitIndex((prev) => Math.min(commits.length - 1, prev + 1));
  }, [commits.length]);

  // Keyboard shortcuts (← → for prev/next, Space for play/pause, Esc to close drawers)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAiDrawerState((s) => ({ ...s, open: false }));
        setMobileSheetOpen(false);
        return;
      }

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === '[' || e.key === 'ArrowLeft') {
        e.preventDefault();
        handleStepPrev();
      } else if (e.key === ']' || e.key === 'ArrowRight') {
        e.preventDefault();
        handleStepNext();
      } else if (e.key === ' ') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleStepPrev, handleStepNext]);

  const handleJumpToCommitSha = (sha: string) => {
    const idx = commits.findIndex((c) => c.sha === sha);
    if (idx !== -1) {
      setIsPlaying(false);
      setActiveCommitIndex(idx);
    }
  };

  const handleSaveNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCommit) return;
    const trimmed = draftNote.trim();
    const updated = {
      ...annotations,
      [activeCommit.sha]: trimmed,
    };
    setAnnotations(updated);

    if (user) {
      try {
        await saveCommitAnnotation(user.uid, activeRepo.id, activeCommit.sha, trimmed);
      } catch (err) {
        console.error('Failed to save annotation to Firestore:', err);
      }
    } else {
      try {
        localStorage.setItem('gitreplay_annotations_v1', JSON.stringify(updated));
      } catch {
        // Ignore storage quota errors
      }
    }

    setNoteSavedToast(true);
    setTimeout(() => setNoteSavedToast(false), 1800);
  };

  const handleExportMarkdownReport = () => {
    exportOnboardingMarkdown(activeRepo, annotations);
    setExportedBanner(true);
    setTimeout(() => setExportedBanner(false), 2000);
  };

  const handleExportPdfSummary = () => {
    exportOnboardingSummaryPdf(activeRepo, annotations);
    setExportedBanner(true);
    setTimeout(() => setExportedBanner(false), 2000);
  };

  const handleImportRepository = async (newRepo: GitRepository) => {
    if (user) {
      try {
        const persistedId = await saveUserRepository(user.uid, newRepo);
        if (persistedId) {
          newRepo.id = persistedId;
        }
      } catch (err) {
        console.error('Failed to persist imported repository:', err);
      }
    } else {
      setSessionRepos((prev) => [newRepo, ...prev]);
    }
    setActiveRepoId(newRepo.id);
    setActiveCommitIndex(0);
    setBaseCommitIndex(null);
    setActiveTab('overview');
    if (newRepo.commits[0]?.files[0]) {
      setSelectedFilePath(newRepo.commits[0].files[0].path);
    }
  };

  const isCustomRepo = (id: string) =>
    !CURATED_REPOSITORIES.some((curated) => curated.id === id);

  return (
    <div className="min-h-screen flex flex-col bg-[var(--gr-bg)] text-[var(--gr-text)] transition-colors duration-150 ease-out">
      {/* 1. Slim Top Bar */}
      <TopBar
        repositories={repositories}
        activeRepo={activeRepo}
        activeTab={activeTab}
        theme={theme}
        user={user}
        exportedBanner={exportedBanner}
        isCustomRepo={isCustomRepo}
        onSelectRepo={handleSelectRepository}
        onDeleteRepo={handleDeleteSavedRepo}
        onSelectTab={(tab) => {
          setIsPlaying(false);
          setActiveTab(tab);
        }}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onOpenImportModal={(mode) => setImportModalState({ open: true, initialTab: mode })}
        onExportMarkdown={handleExportMarkdownReport}
        onExportPdf={handleExportPdfSummary}
        onSignIn={handleGoogleSignIn}
        onSignOut={handleSignOut}
      />

      {/* Mobile Primary Tabs Bar (since desktop tabs are centered in TopBar) */}
      <div className="flex md:hidden items-center gap-6 px-6 h-11 bg-[var(--gr-surface)] border-b border-[var(--gr-border)] text-[12px] font-medium">
        {(
          [
            { id: 'overview', label: 'Overview' },
            { id: 'timeline', label: 'Timeline' },
            { id: 'architecture', label: 'Architecture' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setIsPlaying(false);
              setActiveTab(tab.id);
            }}
            className={`relative h-full flex items-center cursor-pointer transition-colors duration-150 ${
              activeTab === tab.id
                ? 'text-[var(--gr-text)] font-semibold'
                : 'text-[var(--gr-muted)]'
            }`}
          >
            <span>{tab.label}</span>
            {activeTab === tab.id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#E0A458]" />
            )}
          </button>
        ))}
      </div>

      {/* Auth Error Notice */}
      {authError && (
        <div className="px-6 py-2 bg-[var(--gr-danger-bg)] border-b border-[var(--gr-danger-border)] text-[12px] text-[var(--gr-danger-text)] flex items-center justify-between">
          <span>Authentication error: {authError}</span>
          <button
            type="button"
            onClick={() => setAuthError(null)}
            className="underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 2. Overview Tab (Default Day-1 Onboarding Landing) */}
      {activeTab === 'overview' && (
        <main className="flex-1 overflow-y-auto">
          <OverviewTab
            repository={activeRepo}
            isLoading={isLoadingRepos}
            onStartGuidedTour={() => {
              setActiveCommitIndex(0);
              setBaseCommitIndex(null);
              setTimelineViewMode('diff');
              setActiveTab('timeline');
              setIsPlaying(true);
            }}
            onSelectCommitIndex={(idx) => {
              setIsPlaying(false);
              setActiveCommitIndex(idx);
              setTimelineViewMode('diff');
              setActiveTab('timeline');
            }}
            onOpenArchitecture={() => {
              setIsPlaying(false);
              setActiveTab('architecture');
            }}
          />
        </main>
      )}

      {/* Pagination / Rate-limit Error Notice */}
      {paginationError && (
        <div className="px-6 py-2 bg-[var(--gr-danger-bg)] border-b border-[var(--gr-danger-border)] text-[12px] text-[var(--gr-danger-text)] flex items-center justify-between">
          <span>{paginationError}</span>
          <button
            type="button"
            onClick={() => setPaginationError(null)}
            className="underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 3. Timeline Tab (3-Zone Layout: Top Slim Bar + 60% CodeViewer + 40% Why-This-Change Panel) */}
      {activeTab === 'timeline' && (
        <div className="flex-1 flex flex-col min-h-0">
          <TimelineBar
            commits={commits}
            activeIndex={safeCommitIndex}
            isPlaying={isPlaying}
            playbackSpeed={playbackSpeed}
            loopPlayback={loopPlayback}
            categoryFilter={categoryFilter}
            viewMode={timelineViewMode}
            hasMore={Boolean(activeRepo.githubMeta?.hasMore)}
            isLoadingMore={isLoadingMoreCommits}
            onLoadMore={handleLoadMoreCommits}
            onSelectIndex={(idx) => {
              setIsPlaying(false);
              setActiveCommitIndex(idx);
            }}
            onTogglePlay={() => setIsPlaying((p) => !p)}
            onStepPrev={handleStepPrev}
            onStepNext={handleStepNext}
            onChangeSpeed={setPlaybackSpeed}
            onToggleLoop={() => setLoopPlayback((l) => !l)}
            onChangeCategoryFilter={setCategoryFilter}
            onChangeViewMode={setTimelineViewMode}
          />

          <main className="flex-1 grid grid-cols-1 lg:grid-cols-10 min-h-[580px]">
            {/* Left/Center 60% (6/10 cols): Code Viewer or Commit Matrix List */}
            <div className="lg:col-span-6 border-b lg:border-b-0 lg:border-r border-[var(--gr-border)] flex flex-col min-w-0">
              {timelineViewMode === 'diff' ? (
                <CodeViewer
                  commits={commits}
                  activeCommitIndex={safeCommitIndex}
                  baseCommitIndex={baseCommitIndex}
                  selectedFilePath={selectedFilePath}
                  onSelectFile={setSelectedFilePath}
                  onJumpToCommitSha={handleJumpToCommitSha}
                  onTogglePinBase={setBaseCommitIndex}
                  onRetryLoadDiff={(sha) => {
                    const target = commits.find((c) => c.sha === sha);
                    if (target) {
                      loadCommitDiff(activeRepo, target, true);
                    }
                  }}
                />
              ) : (
                <CommitMatrixTable
                  commits={commits}
                  activeCommitIndex={safeCommitIndex}
                  baseCommitIndex={baseCommitIndex}
                  hasMore={Boolean(activeRepo.githubMeta?.hasMore)}
                  isLoadingMore={isLoadingMoreCommits}
                  onLoadMore={handleLoadMoreCommits}
                  onSelectCommitIndex={(idx) => {
                    setIsPlaying(false);
                    setActiveCommitIndex(idx);
                    setTimelineViewMode('diff');
                  }}
                  onPinBaseCommitIndex={setBaseCommitIndex}
                />
              )}
            </div>

            {/* Right 40% (4/10 cols): Desktop "Why this change" Panel */}
            <aside className="hidden lg:flex lg:col-span-4 flex-col min-w-0">
              <CommitInsightPanel
                commit={activeCommit}
                hasPrev={safeCommitIndex > 0}
                hasNext={safeCommitIndex < commits.length - 1}
                draftNote={draftNote}
                noteSavedToast={noteSavedToast}
                isSignedIn={Boolean(user)}
                onStepPrev={handleStepPrev}
                onStepNext={handleStepNext}
                onChangeDraftNote={setDraftNote}
                onSaveNote={handleSaveNote}
                onOpenAIAnalysis={() =>
                  setAiDrawerState({ open: true, tab: 'analyze' })
                }
                onOpenAIChat={() => setAiDrawerState({ open: true, tab: 'chat' })}
              />
            </aside>
          </main>

          {/* Mobile Bottom Sheet Trigger Bar */}
          <div className="lg:hidden sticky bottom-0 z-20 px-4 py-3 bg-[var(--gr-surface)] border-t border-[var(--gr-border)] flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setMobileSheetOpen(true)}
              className="flex-1 text-left flex items-center justify-between gap-3 cursor-pointer"
            >
              <div className="min-w-0">
                <div className="text-[12px] font-medium text-[var(--gr-accent-text)]">
                  Why this change · {activeCommit.shortSha}
                </div>
                <div className="text-[12px] font-medium text-[var(--gr-text)] truncate">
                  {activeCommit.title}
                </div>
              </div>
              <ChevronUp className="w-4 h-4 text-[var(--gr-muted)] shrink-0" />
            </button>
          </div>
        </div>
      )}

      {/* 4. Architecture Tab */}
      {activeTab === 'architecture' && (
        <main className="flex-1 overflow-y-auto">
          <ArchitectureView
            commits={commits}
            activeCommitIndex={safeCommitIndex}
            onSelectCommitIndex={(idx) => {
              setIsPlaying(false);
              setActiveCommitIndex(idx);
            }}
            onInspectCommitCode={(idx) => {
              setIsPlaying(false);
              setActiveCommitIndex(idx);
              setTimelineViewMode('diff');
              setActiveTab('timeline');
            }}
          />
        </main>
      )}

      {/* Mobile Bottom Sheet for CommitInsightPanel */}
      {mobileSheetOpen && activeTab === 'timeline' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Why this change"
          className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs"
        >
          <div
            className="flex-1"
            onClick={() => setMobileSheetOpen(false)}
          />
          <div className="h-[80vh] rounded-t-xl bg-[var(--gr-surface)] border-t border-[var(--gr-border)] flex flex-col overflow-hidden shadow-xl">
            <div className="px-5 py-3 border-b border-[var(--gr-border)] flex items-center justify-between">
              <span className="text-[12px] font-semibold text-[var(--gr-text)]">
                Commit Insight ({activeCommit.shortSha})
              </span>
              <button
                type="button"
                onClick={() => setMobileSheetOpen(false)}
                aria-label="Close commit insight"
                className="p-1 text-[var(--gr-muted)] hover:text-[var(--gr-text)] cursor-pointer transition-colors duration-150"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <CommitInsightPanel
                commit={activeCommit}
                hasPrev={safeCommitIndex > 0}
                hasNext={safeCommitIndex < commits.length - 1}
                draftNote={draftNote}
                noteSavedToast={noteSavedToast}
                isSignedIn={Boolean(user)}
                onStepPrev={handleStepPrev}
                onStepNext={handleStepNext}
                onChangeDraftNote={setDraftNote}
                onSaveNote={handleSaveNote}
                onOpenAIAnalysis={() => {
                  setMobileSheetOpen(false);
                  setAiDrawerState({ open: true, tab: 'analyze' });
                }}
                onOpenAIChat={() => {
                  setMobileSheetOpen(false);
                  setAiDrawerState({ open: true, tab: 'chat' });
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Progressive Disclosure Slide-Over Drawer: AI Commit Analysis & Multi-Turn Chatbot */}
      {aiDrawerState.open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="AI Commit Assistant"
          className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs"
        >
          <div
            className="flex-1"
            onClick={() => setAiDrawerState((s) => ({ ...s, open: false }))}
          />
          <div className="w-full max-w-3xl h-full bg-[var(--gr-bg)] border-l border-[var(--gr-border)] flex flex-col shadow-xl">
            <div className="px-6 py-3.5 bg-[var(--gr-surface)] border-b border-[var(--gr-border)] flex items-center justify-between gap-4">
              <div className="inline-flex items-center rounded-lg bg-[var(--gr-bg)] border border-[var(--gr-border)] p-0.5">
                <button
                  type="button"
                  onClick={() => setAiDrawerState({ open: true, tab: 'analyze' })}
                  className={`h-7 px-3 rounded-md text-[12px] font-medium transition-colors duration-150 ease-out cursor-pointer ${
                    aiDrawerState.tab === 'analyze'
                      ? 'bg-[var(--gr-surface)] text-[var(--gr-text)] shadow-xs'
                      : 'text-[var(--gr-muted)] hover:text-[var(--gr-text)]'
                  }`}
                >
                  Commit Analysis
                </button>
                <button
                  type="button"
                  onClick={() => setAiDrawerState({ open: true, tab: 'chat' })}
                  className={`h-7 px-3 rounded-md text-[12px] font-medium transition-colors duration-150 ease-out cursor-pointer ${
                    aiDrawerState.tab === 'chat'
                      ? 'bg-[var(--gr-surface)] text-[var(--gr-text)] shadow-xs'
                      : 'text-[var(--gr-muted)] hover:text-[var(--gr-text)]'
                  }`}
                >
                  Ask Assistant
                </button>
              </div>

              <button
                type="button"
                onClick={() => setAiDrawerState((s) => ({ ...s, open: false }))}
                aria-label="Close assistant drawer"
                className="p-1.5 rounded-lg text-[var(--gr-muted)] hover:text-[var(--gr-text)] hover:bg-[var(--gr-surface-elevated)] cursor-pointer transition-colors duration-150"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-hidden">
              {aiDrawerState.tab === 'analyze' ? (
                <AIArchitectAnalyzer
                  user={user}
                  repoId={activeRepo.id}
                  commit={activeCommit}
                  repositoryName={`${activeRepo.owner}/${activeRepo.name}`}
                  baseCommitShortSha={
                    baseCommitIndex !== null ? commits[baseCommitIndex]?.shortSha : null
                  }
                />
              ) : (
                <GeminiChatbotPanel
                  user={user}
                  repoId={activeRepo.id}
                  repositoryName={`${activeRepo.owner}/${activeRepo.name}`}
                  commit={activeCommit}
                  totalCommits={commits.length}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Import GitHub / Raw Git Log Modal */}
      <ImportGitModal
        isOpen={importModalState.open}
        initialTab={importModalState.initialTab}
        onClose={() => setImportModalState((s) => ({ ...s, open: false }))}
        onImportRepository={handleImportRepository}
      />
    </div>
  );
}
