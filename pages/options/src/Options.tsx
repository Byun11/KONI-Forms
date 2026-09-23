import { useState, useEffect } from 'react';
import '@src/Options.css';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { t } from '@extension/i18n';
import { FiSettings, FiCpu, FiShield } from 'react-icons/fi';
import { GeneralSettings } from './components/GeneralSettings';
import { ModelSettings } from './components/ModelSettings';
import { FirewallSettings } from './components/FirewallSettings';

type TabTypes = 'general' | 'models' | 'firewall';

const TABS: { id: TabTypes; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { id: 'general', icon: FiSettings, label: t('options_tabs_general') },
  { id: 'models', icon: FiCpu, label: t('options_tabs_models') },
  { id: 'firewall', icon: FiShield, label: t('options_tabs_firewall') },
];

const Options = () => {
  const [activeTab, setActiveTab] = useState<TabTypes>('models');
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Check for dark mode preference
  useEffect(() => {
    const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDarkMode(darkModeMediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsDarkMode(e.matches);
    };

    darkModeMediaQuery.addEventListener('change', handleChange);
    return () => darkModeMediaQuery.removeEventListener('change', handleChange);
  }, []);

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return <GeneralSettings isDarkMode={isDarkMode} />;
      case 'models':
        return <ModelSettings isDarkMode={isDarkMode} />;
      case 'firewall':
        return <FirewallSettings isDarkMode={isDarkMode} />;
      default:
        return null;
    }
  };

  return (
    <div
      className={`flex min-h-screen min-w-[768px] ${isDarkMode ? 'bg-slate-900 text-gray-200' : 'bg-koni-neutral-50 text-koni-neutral-900'}`}>
      {/* Vertical Navigation Bar */}
      <nav
        className={`w-52 flex-col border-r ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-koni-neutral-200 bg-white'} flex`}>
        <div className="p-4">
          <h1
            className={`mb-6 text-base font-semibold tracking-tight ${isDarkMode ? 'text-gray-200' : 'text-koni-navy-900'}`}>
            {t('options_nav_header')}
          </h1>
          <ul className="space-y-1">
            {TABS.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-4 py-2.5 text-left text-sm transition-colors
                    ${
                      activeTab === item.id
                        ? isDarkMode
                          ? 'bg-sky-900/50 font-medium text-sky-300'
                          : 'bg-koni-primary-50 font-medium text-koni-primary-600 shadow-[inset_3px_0_0_0_theme(colors.koni.gold.500)]'
                        : isDarkMode
                          ? 'text-gray-300 hover:bg-slate-700'
                          : 'text-koni-neutral-700 hover:bg-koni-neutral-100'
                    }`}>
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
          {/* KONI / KISTI 브랜딩 */}
          <div className={`mt-8 border-t pt-4 ${isDarkMode ? 'border-slate-700' : 'border-koni-neutral-200'}`}>
            <div className="flex items-center gap-2 border-l-2 border-koni-gold-500 pl-3">
              <img src="/icon-32.png" alt="KONI" className="size-7 rounded-full" />
              <div className="leading-tight">
                <div className={`text-sm font-bold ${isDarkMode ? 'text-gray-200' : 'text-koni-navy-900'}`}>KONI</div>
                <div className={`text-[10px] ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>
                  KISTI Open Neural Intelligence
                </div>
              </div>
            </div>
            <div className={`mt-2 text-[10px] ${isDarkMode ? 'text-gray-500' : 'text-koni-neutral-500'}`}>
              powered by KISTI
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className={`flex-1 ${isDarkMode ? 'bg-slate-800/50' : 'bg-koni-neutral-50'} overflow-y-auto p-8`}>
        <div className="mx-auto min-w-[512px] max-w-screen-lg pb-16">{renderTabContent()}</div>
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <div>Loading...</div>), <div>Error Occurred</div>);
