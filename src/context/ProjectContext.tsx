import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { API_BASE } from "../config/api";
import { withLocalApiAuth } from "../lib/agentAuth";

interface Project {
  id: string;
  name: string;
  genre: string;
  description: string;
  structure?: string;
  custom_structure?: string;
  chapter_words?: number;
  priority?: string;
  status: string;
  model_main: string;
  model_secondary: string;
  temperature: number;
  word_target: number;
}

interface ProjectContextType {
  currentProject: Project | null;
  setCurrentProject: (p: Project | null) => void;
  api: <T = unknown>(path: string, options?: RequestInit) => Promise<T>;
  agentReady: boolean;
}

const ProjectContext = createContext<ProjectContextType | null>(null);

const CURRENT_PROJECT_STORAGE_KEY = "sanhuoai-current-project";

const loadPersistedProject = (): Project | null => {
  try {
    const raw = localStorage.getItem(CURRENT_PROJECT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === "string") return parsed as Project;
  } catch { /* ignore */ }
  return null;
};

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [currentProject, setCurrentProjectRaw] = useState<Project | null>(loadPersistedProject);
  const [agentReady, setAgentReady] = useState(false);

  const setCurrentProject = useCallback((p: Project | null) => {
    setCurrentProjectRaw(p);
    try {
      if (p) {
        localStorage.setItem(CURRENT_PROJECT_STORAGE_KEY, JSON.stringify(p));
      } else {
        localStorage.removeItem(CURRENT_PROJECT_STORAGE_KEY);
      }
    } catch { /* ignore storage errors */ }
  }, []);

  const fetchWithTimeout = useCallback(async (url: string, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        signal: controller.signal,
        headers: withLocalApiAuth(),
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  // Poll /health until agent is ready
  useEffect(() => {
    if (agentReady) return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        try {
          const res = await fetchWithTimeout(`${API_BASE}/health`, 2000);
          if (res.ok) { setAgentReady(true); return; }
        } catch { /* not ready yet */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [agentReady, fetchWithTimeout]);

  const api = useCallback(async <T = unknown>(path: string, options?: RequestInit): Promise<T> => {
    const headers = withLocalApiAuth(options?.headers);
    if (!(options?.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const method = String(options?.method || "GET").trim().toUpperCase();
    const isReadRequest = method === "GET" || method === "HEAD";
    const maxRetries = isReadRequest ? 1 : 0;
    let attempt = 0;

    while (true) {
      let res: Response;
      try {
        res = await fetch(`${API_BASE}${path}`, {
          ...options,
          cache: options?.cache ?? (isReadRequest ? "no-store" : undefined),
          headers,
        });
      } catch (error) {
        if (attempt < maxRetries) {
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
          continue;
        }
        throw error;
      }

      if (!res.ok) {
        const text = await res.text();
        const canRetryStatus =
          isReadRequest && [408, 425, 429, 500, 502, 503, 504].includes(res.status);
        if (canRetryStatus && attempt < maxRetries) {
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
          continue;
        }
        if (res.status === 404 && /not found/i.test(text)) {
          throw new Error(`API 404: 路由不存在（${path}），请重启三火AI后再试`);
        }
        throw new Error(`API ${res.status}: ${text}`);
      }

      if (res.status === 204) {
        return undefined as T;
      }
      const raw = await res.text();
      const text = raw.trim();
      if (!text) {
        return undefined as T;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        return raw as unknown as T;
      }
    }
  }, []);

  return (
    <ProjectContext.Provider value={{ currentProject, setCurrentProject, api, agentReady }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used within ProjectProvider");
  return ctx;
}
