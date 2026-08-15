'use client';

import { create } from 'zustand';
import type { DrawerTab, ExecutionFilter, ExecutionStep } from '@/lib/execution/types';

interface ExecutionStore {
  // ── Drawer ────────────────────────────────────────────────────────────────
  drawerOpen:  boolean;
  activeStep:  ExecutionStep | null;
  activeTab:   DrawerTab;

  openDrawer:  (step: ExecutionStep) => void;
  closeDrawer: () => void;
  setTab:      (tab: DrawerTab) => void;

  // ── List filters + pagination ─────────────────────────────────────────────
  filters:     ExecutionFilter;
  page:        number;

  setFilters:   (patch: Partial<ExecutionFilter>) => void;
  resetFilters: () => void;
  setPage:      (page: number) => void;
}

const DEFAULT_FILTERS: ExecutionFilter = {
  workflow_id: '',
  status:      '',
  mode:        '',
  from:        '',
  to:          '',
  search:      '',
};

export const useExecutionStore = create<ExecutionStore>()((set) => ({
  // ── Drawer defaults ───────────────────────────────────────────────────────
  drawerOpen: false,
  activeStep: null,
  activeTab:  'input' as DrawerTab,

  openDrawer:  (step: ExecutionStep) => set({ drawerOpen: true, activeStep: step, activeTab: 'input' }),
  closeDrawer: ()                    => set({ drawerOpen: false, activeStep: null }),
  setTab:      (tab: DrawerTab)      => set({ activeTab: tab }),

  // ── Filter defaults ───────────────────────────────────────────────────────
  filters: DEFAULT_FILTERS,
  page:    1,

  setFilters:   (patch: Partial<ExecutionFilter>) =>
    set((s) => ({ filters: { ...s.filters, ...patch }, page: 1 })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS, page: 1 }),
  setPage:      (page: number) => set({ page }),
}));
