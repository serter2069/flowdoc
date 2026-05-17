export type RunStatus = "pass" | "fail" | "skip" | "untested";

export interface ScreenRun {
  status: RunStatus;
  httpStatus?: number;
  ms?: number;
  runId?: string;
  startedAt?: string;
  error?: string;
}

export interface RunMeta {
  id: string;
  startedAt: string;
  platform: string;
  viewport?: string;
  baseUrl?: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface BaselineByState {
  [stateNum: number]: {
    [platform: string]: {
      status: string;            // match | drift | new | error | skipped
      driftPct?: number;
      scenarioId: string;
      stepIdx: number;
      ranAt: string;
      diffPath?: string;
      baselinePath?: string;
      currentPath?: string;
    };
  };
}

export interface RunsData {
  platforms: string[];
  byScreen: Record<string, Record<string, ScreenRun>>;
  runs: RunMeta[];
  baselinePlatforms?: string[];
  baselineByState?: BaselineByState;
  baselineRunsCount?: number;
}

export const EMPTY_RUNS: RunsData = { platforms: [], byScreen: {}, runs: [], baselinePlatforms: [], baselineByState: {}, baselineRunsCount: 0 };

export function loadRuns(): RunsData {
  const node = document.getElementById("flowdoc-runs");
  if (!node || !node.textContent) return EMPTY_RUNS;
  const raw = node.textContent.trim();
  if (!raw || raw === "__FLOWDOC_RUNS__" || raw === "null") return EMPTY_RUNS;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_RUNS;
    return { ...EMPTY_RUNS, ...parsed } as RunsData;
  } catch {
    return EMPTY_RUNS;
  }
}
