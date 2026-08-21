import { create } from "zustand";
import { api, type Environment, type Endpoint, type ProjectMetric } from "../api";

type ProjectState = {
  projects: ProjectMetric[];
  projectId: string | null;
  project: ProjectMetric | null;
  environments: Environment[];
  defaultEnvironmentId: string | null;
  /** Project opt-in: execution records are stored unmasked for easier debugging. */
  storePlaintext: boolean;
  endpoints: Endpoint[];
  loading: boolean;
  refresh: () => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  reloadEndpoints: () => Promise<void>;
  reloadEnvironments: () => Promise<void>;
  updateDefaultEnvironment: (environmentId: string | null) => Promise<void>;
  updateStorePlaintext: (storePlaintext: boolean) => Promise<void>;
};

/**
 * Execution records deliberately live outside this store: they are paginated
 * per page and must not be capped by a shared prefetch.
 */
export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [], projectId: null, project: null, environments: [], defaultEnvironmentId: null, storePlaintext: false, endpoints: [], loading: false,

  refresh: async () => {
    const projects = await api.projects();
    set({ projects, project: projects.find((item) => item.id === get().projectId) ?? get().project });
  },

  loadProject: async (id) => {
    if (get().projectId !== id) set({ projectId: id, environments: [], defaultEnvironmentId: null, storePlaintext: false, endpoints: [], project: null });
    set({ loading: true });
    try {
      const [environments, endpoints, settings] = await Promise.all([api.environments(id), api.endpoints(id), api.projectSettings(id)]);
      if (get().projectId !== id) return;
      set({ projectId: id, environments, defaultEnvironmentId: settings.defaultEnvironmentId ?? null, storePlaintext: settings.storePlaintext, endpoints, project: get().projects.find((item) => item.id === id) ?? null });
    } finally { if (get().projectId === id) set({ loading: false }); }
  },

  reloadEndpoints: async () => { const id = get().projectId; if (id) set({ endpoints: await api.endpoints(id) }); },
  reloadEnvironments: async () => {
    const id = get().projectId; if (!id) return;
    const [environments, settings] = await Promise.all([api.environments(id), api.projectSettings(id)]);
    if (get().projectId === id) set({ environments, defaultEnvironmentId: settings.defaultEnvironmentId ?? null, storePlaintext: settings.storePlaintext });
  },
  updateDefaultEnvironment: async (environmentId) => {
    const id = get().projectId; if (!id) return;
    const settings = await api.updateProjectSettings(id, { defaultEnvironmentId: environmentId, storePlaintext: get().storePlaintext });
    set({ defaultEnvironmentId: settings.defaultEnvironmentId ?? null, storePlaintext: settings.storePlaintext });
  },
  updateStorePlaintext: async (storePlaintext) => {
    const id = get().projectId; if (!id) return;
    const settings = await api.updateProjectSettings(id, { defaultEnvironmentId: get().defaultEnvironmentId, storePlaintext });
    set({ defaultEnvironmentId: settings.defaultEnvironmentId ?? null, storePlaintext: settings.storePlaintext });
  },
}));
