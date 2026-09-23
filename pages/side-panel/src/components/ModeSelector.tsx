import { useEffect, useRef, useState } from 'react';
import { FiCheck, FiChevronDown } from 'react-icons/fi';
import { generalSettingsStore } from '@extension/storage';
import { t } from '@extension/i18n';

interface ModeSelectorProps {
  isDarkMode?: boolean;
}

/**
 * Claude-style execution-mode picker in the composer: "Auto run" (agent acts
 * without pausing) vs "Plan approval" (executor pauses after each plan until
 * the user approves). Persisted in generalSettingsStore; the executor reads it
 * at task setup, so a change applies from the next task.
 */
export default function ModeSelector({ isDarkMode = false }: ModeSelectorProps) {
  const [planApproval, setPlanApproval] = useState(false);
  const [open, setOpen] = useState(false);
  // Viewport coords for the popover: the composer form clips overflow (rounded
  // corners), so an absolutely-positioned popover gets cut off — render it
  // position:fixed anchored to the button instead.
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    generalSettingsStore
      .getSettings()
      .then(settings => setPlanApproval(settings.planApproval))
      .catch(error => console.error('ModeSelector: failed to load settings', error));
  }, []);

  // Close on click outside / Escape
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const handleSelect = async (value: boolean) => {
    setOpen(false);
    if (value === planApproval) return;
    setPlanApproval(value); // optimistic
    try {
      await generalSettingsStore.updateSettings({ planApproval: value });
    } catch (error) {
      console.error('ModeSelector: failed to save setting', error);
      setPlanApproval(!value);
    }
  };

  const options: Array<{ value: boolean; label: string }> = [
    { value: false, label: t('chat_mode_auto') },
    { value: true, label: t('chat_mode_planApproval') },
  ];
  const currentLabel = planApproval ? t('chat_mode_planApproval') : t('chat_mode_auto');

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (!open) {
            const rect = buttonRef.current?.getBoundingClientRect();
            if (rect) setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 4 });
          }
          setOpen(prev => !prev);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('chat_mode_a11y')}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors ${
          isDarkMode
            ? 'text-gray-400 hover:bg-slate-700 hover:text-gray-200'
            : 'text-koni-neutral-500 hover:bg-koni-neutral-100 hover:text-koni-neutral-700'
        }`}>
        <span className="max-w-[120px] truncate">{currentLabel}</span>
        <FiChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && anchor && (
        <div
          role="listbox"
          aria-label={t('chat_mode_a11y')}
          style={{ left: anchor.left, bottom: anchor.bottom }}
          className={`fixed z-50 w-44 rounded-xl border p-1 shadow-lg ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-koni-neutral-200 bg-white'
          }`}>
          {options.map(option => {
            const selected = option.value === planApproval;
            return (
              <button
                key={String(option.value)}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => handleSelect(option.value)}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                  isDarkMode ? 'text-gray-200 hover:bg-slate-700' : 'text-koni-neutral-900 hover:bg-koni-neutral-100'
                }`}>
                <span className="truncate">{option.label}</span>
                {selected && (
                  <FiCheck
                    size={13}
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
