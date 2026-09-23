import { useState, useEffect, useCallback } from 'react';
import { firewallStore } from '@extension/storage';
import { Button } from '@extension/ui';
import { t } from '@extension/i18n';

interface FirewallSettingsProps {
  isDarkMode: boolean;
}

export const FirewallSettings = ({ isDarkMode }: FirewallSettingsProps) => {
  const [isEnabled, setIsEnabled] = useState(true);
  const [allowList, setAllowList] = useState<string[]>([]);
  const [denyList, setDenyList] = useState<string[]>([]);
  const [newUrl, setNewUrl] = useState('');
  const [activeList, setActiveList] = useState<'allow' | 'deny'>('allow');

  const loadFirewallSettings = useCallback(async () => {
    const settings = await firewallStore.getFirewall();
    setIsEnabled(settings.enabled);
    setAllowList(settings.allowList);
    setDenyList(settings.denyList);
  }, []);

  useEffect(() => {
    loadFirewallSettings();
  }, [loadFirewallSettings]);

  const handleToggleFirewall = async () => {
    await firewallStore.updateFirewall({ enabled: !isEnabled });
    await loadFirewallSettings();
  };

  const handleAddUrl = async () => {
    // Remove http:// or https:// prefixes
    const cleanUrl = newUrl.trim().replace(/^https?:\/\//, '');
    if (!cleanUrl) return;

    if (activeList === 'allow') {
      await firewallStore.addToAllowList(cleanUrl);
    } else {
      await firewallStore.addToDenyList(cleanUrl);
    }
    await loadFirewallSettings();
    setNewUrl('');
  };

  const handleRemoveUrl = async (url: string, listType: 'allow' | 'deny') => {
    if (listType === 'allow') {
      await firewallStore.removeFromAllowList(url);
    } else {
      await firewallStore.removeFromDenyList(url);
    }
    await loadFirewallSettings();
  };

  const cardClass = isDarkMode
    ? 'rounded-xl border border-slate-700 bg-slate-800 p-6 text-left shadow-[0_1px_3px_0_rgba(0,0,0,0.06)]'
    : 'rounded-xl border border-koni-neutral-200 bg-white p-6 text-left shadow-[0_1px_3px_0_rgba(0,0,0,0.06)]';

  const urlInputClass = isDarkMode
    ? 'flex-1 rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white focus:border-blue-500 focus:ring-2 focus:ring-blue-800 focus:outline-none'
    : 'flex-1 rounded-lg border border-koni-neutral-300 bg-white px-3 py-2 text-sm text-koni-neutral-900 focus:border-koni-primary-600 focus:ring-2 focus:ring-koni-primary-50 focus:outline-none';

  return (
    <section className="space-y-6">
      <div className={cardClass}>
        <h2
          className={`mb-4 text-lg font-semibold tracking-tight ${isDarkMode ? 'text-gray-200' : 'text-koni-navy-900'}`}>
          {t('options_firewall_header')}
        </h2>

        <div className="space-y-6">
          {/* Firewall enable toggle */}
          <div
            className={`rounded-lg border p-4 ${isDarkMode ? 'border-slate-700 bg-slate-700' : 'border-koni-neutral-200 bg-koni-neutral-50'}`}>
            <div className="flex items-center justify-between">
              <label
                htmlFor="toggle-firewall"
                className={`text-sm font-medium ${isDarkMode ? 'text-gray-200' : 'text-koni-neutral-700'}`}>
                {t('options_firewall_enableToggle')}
              </label>
              <div className="relative inline-block w-12 select-none">
                <input
                  type="checkbox"
                  checked={isEnabled}
                  onChange={handleToggleFirewall}
                  className="sr-only"
                  id="toggle-firewall"
                />
                <label
                  htmlFor="toggle-firewall"
                  className={`block h-6 cursor-pointer overflow-hidden rounded-full ${
                    isEnabled
                      ? isDarkMode
                        ? 'bg-sky-600'
                        : 'bg-koni-primary-600'
                      : isDarkMode
                        ? 'bg-gray-600'
                        : 'bg-koni-neutral-300'
                  }`}>
                  <span className="sr-only">{t('options_firewall_toggleFirewall_a11y')}</span>
                  <span
                    className={`block size-6 rounded-full bg-white shadow transition-transform ${
                      isEnabled ? 'translate-x-6' : 'translate-x-0'
                    }`}
                  />
                </label>
              </div>
            </div>
          </div>

          {/* Allow / Deny segmented switcher */}
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setActiveList('allow')}
              className={`rounded-full px-4 py-2 text-sm font-semibold tracking-tight ${
                activeList === 'allow'
                  ? isDarkMode
                    ? 'bg-sky-700 text-white'
                    : 'bg-koni-primary-600 text-white'
                  : isDarkMode
                    ? 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                    : 'bg-koni-neutral-100 text-koni-neutral-700 hover:bg-koni-neutral-200'
              }`}>
              {t('options_firewall_allowList_header')}
            </Button>
            <Button
              onClick={() => setActiveList('deny')}
              className={`rounded-full px-4 py-2 text-sm font-semibold tracking-tight ${
                activeList === 'deny'
                  ? isDarkMode
                    ? 'bg-sky-700 text-white'
                    : 'bg-koni-primary-600 text-white'
                  : isDarkMode
                    ? 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                    : 'bg-koni-neutral-100 text-koni-neutral-700 hover:bg-koni-neutral-200'
              }`}>
              {t('options_firewall_denyList_header')}
            </Button>
          </div>

          {/* URL input + Add button */}
          <div className="flex gap-2">
            <input
              id="url-input"
              type="text"
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  handleAddUrl();
                }
              }}
              placeholder={t('options_firewall_placeholders_domainUrl')}
              className={urlInputClass}
            />
            <Button
              onClick={handleAddUrl}
              className={`rounded-full px-4 py-2 text-sm font-semibold tracking-tight ${
                isDarkMode
                  ? 'bg-sky-700 text-white hover:bg-sky-600'
                  : 'bg-koni-primary-600 text-white hover:bg-koni-primary-500'
              }`}>
              {t('options_firewall_btnAdd')}
            </Button>
          </div>

          {/* URL list */}
          <div className="max-h-64 overflow-y-auto">
            {activeList === 'allow' ? (
              allowList.length > 0 ? (
                <ul className="space-y-2">
                  {allowList.map(url => (
                    <li
                      key={url}
                      className={`flex items-center justify-between rounded-lg px-3 py-2 ${
                        isDarkMode ? 'bg-slate-700' : 'bg-koni-neutral-50 border border-koni-neutral-200'
                      }`}>
                      <span className={`text-sm ${isDarkMode ? 'text-gray-200' : 'text-koni-neutral-700'}`}>{url}</span>
                      <Button
                        onClick={() => handleRemoveUrl(url, 'allow')}
                        className={`rounded-full px-2 py-1 text-xs font-semibold tracking-tight ${
                          isDarkMode
                            ? 'bg-red-700 text-white hover:bg-red-600'
                            : 'bg-white border border-koni-neutral-200 text-koni-danger hover:bg-red-50'
                        }`}>
                        {t('options_firewall_btnRemove')}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={`text-center text-sm ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>
                  {t('options_firewall_allowList_empty')}
                </p>
              )
            ) : denyList.length > 0 ? (
              <ul className="space-y-2">
                {denyList.map(url => (
                  <li
                    key={url}
                    className={`flex items-center justify-between rounded-lg px-3 py-2 ${
                      isDarkMode ? 'bg-slate-700' : 'bg-koni-neutral-50 border border-koni-neutral-200'
                    }`}>
                    <span className={`text-sm ${isDarkMode ? 'text-gray-200' : 'text-koni-neutral-700'}`}>{url}</span>
                    <Button
                      onClick={() => handleRemoveUrl(url, 'deny')}
                      className={`rounded-full px-2 py-1 text-xs font-semibold tracking-tight ${
                        isDarkMode
                          ? 'bg-red-700 text-white hover:bg-red-600'
                          : 'bg-white border border-koni-neutral-200 text-koni-danger hover:bg-red-50'
                      }`}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`text-center text-sm ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>
                {t('options_firewall_denyList_empty')}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className={cardClass}>
        <h2
          className={`mb-4 text-lg font-semibold tracking-tight ${isDarkMode ? 'text-gray-200' : 'text-koni-navy-900'}`}>
          {t('options_firewall_howItWorks_header')}
        </h2>
        <ul
          className={`list-disc space-y-2 pl-5 text-left text-sm ${isDarkMode ? 'text-gray-300' : 'text-koni-neutral-600'}`}>
          {t('options_firewall_howItWorks')
            .split('\n')
            .map((rule, index) => (
              <li key={index}>{rule}</li>
            ))}
        </ul>
      </div>
    </section>
  );
};
