import { useCallback, useEffect, useRef, useState } from 'react';
import { FiCheck, FiChevronDown } from 'react-icons/fi';
import {
  agentModelStore,
  llmProviderStore,
  llmProviderModelNames,
  getDefaultDisplayNameFromProviderId,
  AgentNameEnum,
  ProviderTypeEnum,
} from '@extension/storage';
import { t } from '@extension/i18n';

interface ModelOption {
  provider: string; // providerId
  providerName: string; // display name
  model: string;
}

interface ModelSelectorProps {
  isDarkMode?: boolean;
}

/**
 * Claude-style model switcher for the side panel: a slim pill under the header
 * showing the current model; clicking opens a listbox of every model configured
 * in Settings. Picking one points BOTH Planner and Navigator at it (fine-grained
 * per-agent choice stays available in Settings). Takes effect from the next task.
 */
export default function ModelSelector({ isDarkMode = false }: ModelSelectorProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [current, setCurrent] = useState<string>(''); // `${provider}>${model}`
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const providers = await llmProviderStore.getAllProviders();
      const options: ModelOption[] = [];
      for (const [providerId, config] of Object.entries(providers)) {
        const providerName = config.name || getDefaultDisplayNameFromProviderId(providerId);
        const names =
          config.type === ProviderTypeEnum.AzureOpenAI
            ? (config.azureDeploymentNames ?? [])
            : (config.modelNames ?? llmProviderModelNames[providerId as keyof typeof llmProviderModelNames] ?? []);
        for (const model of names) {
          options.push({ provider: providerId, providerName, model });
        }
      }
      setModels(options);
      const navConfig = await agentModelStore.getAgentModel(AgentNameEnum.Navigator);
      if (navConfig) setCurrent(`${navConfig.provider}>${navConfig.modelName}`);
    } catch (error) {
      console.error('ModelSelector: failed to load models', error);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Close on click outside / Escape
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleSelect = async (option: ModelOption) => {
    setOpen(false);
    const key = `${option.provider}>${option.model}`;
    if (key === current) return;
    setCurrent(key); // optimistic — store writes below
    try {
      const config = { provider: option.provider, modelName: option.model };
      // One pill drives both agents, Claude-style.
      await agentModelStore.setAgentModel(AgentNameEnum.Navigator, config);
      await agentModelStore.setAgentModel(AgentNameEnum.Planner, config);
    } catch (error) {
      console.error('ModelSelector: failed to set model', error);
      load(); // resync with whatever the store actually holds
    }
  };

  if (models.length === 0) return null;

  const currentModelName = current.includes('>') ? current.split('>')[1] : current;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (!open) load(); // pick up models newly added in Settings
          setOpen(prev => !prev);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('chat_modelSelector_a11y')}
        className={`flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium transition-colors ${
          isDarkMode ? 'text-gray-200 hover:bg-slate-800' : 'text-koni-navy-900 hover:bg-koni-neutral-100'
        }`}>
        <span className="max-w-[180px] truncate">{currentModelName || t('chat_modelSelector_none')}</span>
        <FiChevronDown
          size={14}
          className={`${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'} transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={t('chat_modelSelector_a11y')}
          className={`absolute left-0 top-full z-50 mt-1 max-h-64 w-64 overflow-y-auto rounded-xl border p-1 shadow-lg ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-koni-neutral-200 bg-white'
          }`}>
          {models.map(option => {
            const key = `${option.provider}>${option.model}`;
            const selected = key === current;
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => handleSelect(option)}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                  isDarkMode ? 'hover:bg-slate-700' : 'hover:bg-koni-neutral-100'
                }`}>
                <span className="min-w-0">
                  <span
                    className={`block truncate text-xs font-medium ${isDarkMode ? 'text-gray-200' : 'text-koni-neutral-900'}`}>
                    {option.model}
                  </span>
                  <span
                    className={`block truncate text-[10px] ${isDarkMode ? 'text-gray-500' : 'text-koni-neutral-500'}`}>
                    {option.providerName}
                  </span>
                </span>
                {selected && (
                  <FiCheck
                    size={14}
                    className={isDarkMode ? 'shrink-0 text-sky-400' : 'shrink-0 text-koni-primary-600'}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
