import { create } from "zustand";

type Guard = () => Promise<boolean>;

type NavGuardState = {
  guard: Guard | null;
  /** Registered by an editor with unsaved changes; cleared on unmount. */
  setGuard: (guard: Guard | null) => void;
  /** Resolves true when navigation may proceed. */
  confirmLeave: () => Promise<boolean>;
};

/**
 * Lets the shell's navigation ask the active editor whether it is safe to
 * leave. Without this, removing the in-page back link would have dropped the
 * unsaved-changes prompt entirely, since the sidebar knows nothing about the
 * page it is rendering.
 */
export const useNavGuardStore = create<NavGuardState>((set, get) => ({
  guard: null,
  setGuard: (guard) => set({ guard }),
  confirmLeave: async () => {
    const guard = get().guard;
    return guard ? guard() : true;
  },
}));
