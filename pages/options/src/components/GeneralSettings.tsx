import { useState, useEffect } from 'react';
import { type GeneralSettingsConfig, generalSettingsStore, DEFAULT_GENERAL_SETTINGS } from '@extension/storage';
import { t } from '@extension/i18n';

interface GeneralSettingsProps {
  isDarkMode?: boolean;
}

export const GeneralSettings = ({ isDarkMode = false }: GeneralSettingsProps) => {
  const [settings, setSettings] = useState<GeneralSettingsConfig>(DEFAULT_GENERAL_SETTINGS);

  useEffect(() => {
    // Load initial settings
    generalSettingsStore.getSettings().then(setSettings);
  }, []);

  const updateSetting = async <K extends keyof GeneralSettingsConfig>(key: K, value: GeneralSettingsConfig[K]) => {
    // Optimistically update the local state for responsiveness
    setSettings(prevSettings => ({ ...prevSettings, [key]: value }));

    // Call the store to update the setting
    await generalSettingsStore.updateSettings({ [key]: value } as Partial<GeneralSettingsConfig>);

    // After the store update (which might have side effects, e.g., useVision affecting displayHighlights),
    // fetch the latest settings from the store and update the local state again to ensure UI consistency.
    const latestSettings = await generalSettingsStore.getSettings();
    setSettings(latestSettings);
  };

  // Shared light-mode input class for number inputs
  const numInputClass = isDarkMode
    ? 'w-20 rounded-lg border border-slate-600 bg-slate-700 text-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-800 focus:outline-none'
    : 'w-20 rounded-lg border border-koni-neutral-300 bg-white text-koni-neutral-900 px-3 py-2 text-sm focus:border-koni-primary-600 focus:ring-2 focus:ring-koni-primary-50 focus:outline-none';

  // Shared toggle label class
  const toggleClass = isDarkMode
    ? `peer h-6 w-11 rounded-full bg-slate-600 after:absolute after:left-[2px] after:top-[2px] after:size-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-sky-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-sky-900`
    : `peer h-6 w-11 rounded-full bg-koni-neutral-200 after:absolute after:left-[2px] after:top-[2px] after:size-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-koni-primary-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-koni-primary-100`;

  return (
    <section className="space-y-6">
      <div
        className={`rounded-xl border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-koni-neutral-200 bg-white'} p-6 text-left shadow-[0_1px_3px_0_rgba(0,0,0,0.06)]`}>
        <h2
          className={`mb-4 text-left text-lg font-semibold tracking-tight ${isDarkMode ? 'text-gray-200' : 'text-koni-navy-900'}`}>
          {t('options_general_header')}
        </h2>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className={`text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-koni-neutral-700'}`}>
                {t('options_general_maxSteps')}
              </h3>
              <p className={`text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>
                {t('options_general_maxSteps_desc')}
              </p>
            </div>
            <label htmlFor="maxSteps" className="sr-only">
              {t('options_general_maxSteps')}
            </label>
            <input
              id="maxSteps"
              type="number"
              min={1}
              max={50}
              value={settings.maxSteps}
              onChange={e => updateSetting('maxSteps', Number.parseInt(e.target.value, 10))}
              className={numInputClass}
            />
          </div>

          <div className={`border-t ${isDarkMode ? 'border-slate-700' : 'border-koni-neutral-200'}`} />

          <div className="flex items-center justify-between">
            <div>
              <h3 className={`text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-koni-neutral-700'}`}>
                {t('options_general_maxActions')}
              </h3>
              <p className={`text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>
                {t('options_general_maxActions_desc')}
              </p>
            </div>
            <label htmlFor="maxActionsPerStep" className="sr-only">
              {t('options_general_maxActions')}
            </label>
            <input
              id="maxActionsPerStep"
              type="number"
              min={1}
              max={50}
              value={settings.maxActionsPerStep}
              onChange={e => updateSetting('maxActionsPerStep', Number.parseInt(e.target.value, 10))}
              className={numInputClass}
            />
          </div>

          <div className={`border-t ${isDarkMode ? 'border-slate-700' : 'border-koni-neutral-200'}`} />

          <div className="flex items-center justify-between">
            <div>
              <h3 className={`text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-koni-neutral-700'}`}>
                {t('options_general_maxFailures')}
              </h3>
              <p className={`text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>
                {t('options_general_maxFailures_desc')}
              </p>
            </div>
            <label htmlFor="maxFailures" className="sr-only">
              {t('options_general_maxFailures')}
            </label>
            <input
              id="maxFailures"
              type="number"
              min={1}
              max={10}
              value={settings.maxFailures}
              onChange={e => updateSetting('maxFailures', Number.parseInt(e.target.value, 10))}
              className={numInputClass}
            />
          </div>

          <div className={`border-t ${isDarkMode ? 'border-slate-700' : 'border-koni-neutral-200'}`} />

          <div className="flex items-center justify-between">
            <div>
              <h3 className={`text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-koni-neutral-700'}`}>
                {t('options_general_enableVision')}
              </h3>
              <p className={`text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>
                {t('options_general_enableVision_desc')}
              </p>
            </div>
            <div className="relative inline-flex cursor-pointer items-center">
              <input
                id="useVision"
                type="checkbox"
                checked={settings.useVision}
                onChange={e => updateSetting('useVision', e.target.checked)}
                className="peer sr-only"
              />
              <label htmlFor="useVision" className={toggleClass}>
                <span className="sr-only">{t('options_general_enableVision')}</span>
              </label>
            </div>
          </div>

          <div className={`border-t ${isDarkMode ? 'border-slate-700' : 'border-koni-neutral-200'}`} />

          <div className="flex items-center justify-between">
            <div>
              <h3 className={`text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-koni-neutral-700'}`}>
                {t('options_general_displayHighlights')}
              </h3>
              <p className={`text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>
                {t('options_general_displayHighlights_desc')}
              </p>
            </div>
            <div className="relative inline-flex cursor-pointer items-center">
              <input
                id="displayHighlights"
                type="checkbox"
                checked={settings.displayHighlights}
                onChange={e => updateSetting('displayHighlights', e.target.checked)}
                className="peer sr-only"
              />
              <label htmlFor="displayHighlights" className={toggleClass}>
                <span className="sr-only">{t('options_general_displayHighlights')}</span>
              </label>
            </div>
          </div>

          <div className={`border-t ${isDarkMode ? 'border-slate-700' : 'border-koni-neutral-200'}`} />

          <div className="flex items-center justify-between">
            <div>
              <h3 className={`text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-koni-neutral-700'}`}>
                {t('options_general_planningInterval')}
              </h3>
              <p className={`text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>
                {t('options_general_planningInterval_desc')}
              </p>
            </div>
            <label htmlFor="planningInterval" className="sr-only">
              {t('options_general_planningInterval')}
            </label>
            <input
              id="planningInterval"
              type="number"
              min={1}
              max={20}
              value={settings.planningInterval}
              onChange={e => updateSetting('planningInterval', Number.parseInt(e.target.value, 10))}
              className={numInputClass}
            />
          </div>

          <div className={`border-t ${isDarkMode ? 'border-slate-700' : 'border-koni-neutral-200'}`} />

          <div className="flex items-center justify-between">
            <div>
              <h3 className={`text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-koni-neutral-700'}`}>
                {t('options_general_minWaitPageLoad')}
              </h3>
              <p className={`text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>
                {t('options_general_minWaitPageLoad_desc')}
              </p>
            </div>
            <div className="flex items-center space-x-2">
              <label htmlFor="minWaitPageLoad" className="sr-only">
                {t('options_general_minWaitPageLoad')}
              </label>
              <input
                id="minWaitPageLoad"
                type="number"
                min={250}
                max={5000}
                step={50}
                value={settings.minWaitPageLoad}
                onChange={e => updateSetting('minWaitPageLoad', Number.parseInt(e.target.value, 10))}
                className={numInputClass}
              />
            </div>
          </div>

          {/* Replay Historical Tasks (upstream, experimental) is hidden: the setting stays
              false, which also keeps the replay button out of the side panel. */}

          <div className={`border-t ${isDarkMode ? 'border-slate-700' : 'border-koni-neutral-200'}`} />

          <div className="flex items-center justify-between">
            <div>
              <h3 className={`text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-koni-neutral-700'}`}>
                {t('options_general_askBeforeIrreversible')}
              </h3>
              <p className={`text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>
                {t('options_general_askBeforeIrreversible_desc')}
              </p>
            </div>
            <div className="relative inline-flex cursor-pointer items-center">
              <input
                id="askBeforeIrreversible"
                type="checkbox"
                checked={settings.askBeforeIrreversible}
                onChange={e => updateSetting('askBeforeIrreversible', e.target.checked)}
                className="peer sr-only"
              />
              <label htmlFor="askBeforeIrreversible" className={toggleClass}>
                <span className="sr-only">{t('options_general_askBeforeIrreversible')}</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
