import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Interface for general settings configuration
export interface GeneralSettingsConfig {
  maxSteps: number;
  maxActionsPerStep: number;
  maxFailures: number;
  useVision: boolean;
  useVisionForPlanner: boolean;
  planningInterval: number;
  displayHighlights: boolean;
  minWaitPageLoad: number;
  replayHistoricalTasks: boolean;
  // When true, the executor pauses after each plan and waits for the user's
  // approval before acting (Claude-style plan approval).
  planApproval: boolean;
  // When true (default), the navigator system prompt requires the agent to
  // call ask_user and wait for confirmation before irreversible actions
  // (form submission, payment, sending messages/emails, account changes).
  askBeforeIrreversible: boolean;
  // Page observation: 'axtree' (accessibility tree over CDP — controls carry
  // their accessible name, labels/headings appear as context) or 'dom'
  // (injected DOM walk, kept for ablation).
  observationMode: 'dom' | 'axtree';
}

export type GeneralSettingsStorage = BaseStorage<GeneralSettingsConfig> & {
  updateSettings: (settings: Partial<GeneralSettingsConfig>) => Promise<void>;
  getSettings: () => Promise<GeneralSettingsConfig>;
  resetToDefaults: () => Promise<void>;
};

// Default settings
export const DEFAULT_GENERAL_SETTINGS: GeneralSettingsConfig = {
  maxSteps: 100,
  maxActionsPerStep: 5,
  maxFailures: 3,
  // KONI's document tools (view_doc sticky page, screenshots) presume a
  // vision-capable model — vision on is the product default; text-only
  // model users opt out via the settings toggle.
  useVision: true,
  useVisionForPlanner: false,
  planningInterval: 3,
  displayHighlights: true,
  minWaitPageLoad: 250,
  replayHistoricalTasks: false,
  planApproval: false,
  // Irreversible actions (submit/payment/send) ask for confirmation by default.
  askBeforeIrreversible: true,
  observationMode: 'axtree',
};

const storage = createStorage<GeneralSettingsConfig>('general-settings', DEFAULT_GENERAL_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const generalSettingsStore: GeneralSettingsStorage = {
  ...storage,
  async updateSettings(settings: Partial<GeneralSettingsConfig>) {
    const currentSettings = (await storage.get()) || DEFAULT_GENERAL_SETTINGS;
    const updatedSettings = {
      ...currentSettings,
      ...settings,
    };

    // displayHighlights only decides whether the numbered marks are painted onto the page;
    // it is independent of useVision (the screenshot is taken either way).
    await storage.set(updatedSettings);
  },
  async getSettings() {
    const settings = await storage.get();
    return {
      ...DEFAULT_GENERAL_SETTINGS,
      ...settings,
    };
  },
  async resetToDefaults() {
    await storage.set(DEFAULT_GENERAL_SETTINGS);
  },
};
