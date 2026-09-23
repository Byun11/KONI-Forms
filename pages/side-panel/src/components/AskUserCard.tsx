import { FiHelpCircle } from 'react-icons/fi';
import { t } from '@extension/i18n';

interface AskUserCardProps {
  question: string;
  isDarkMode?: boolean;
}

/**
 * ask_user question card: shown after the run ended as 'awaiting_user' (the
 * agent asked a question and stopped). Visually consistent with
 * PlanApprovalCard, but with NO buttons — the user types the answer in the
 * normal input box below and it goes out as a follow-up task that continues
 * the session. Cleared when the next task starts.
 */
export default function AskUserCard({ question, isDarkMode = false }: AskUserCardProps) {
  return (
    <div
      className={`rounded-xl border p-3 shadow-sm ${
        isDarkMode ? 'border-slate-600 bg-slate-800' : 'border-koni-neutral-200 bg-white'
      }`}>
      <p
        className={`mb-2 flex items-center gap-1.5 text-sm font-semibold ${
          isDarkMode ? 'text-gray-100' : 'text-koni-navy-900'
        }`}>
        <FiHelpCircle size={15} className={isDarkMode ? 'shrink-0 text-sky-400' : 'shrink-0 text-koni-primary-600'} />
        {t('chat_ask_title')}
      </p>

      <p
        className={`max-h-48 overflow-y-auto whitespace-pre-wrap text-sm leading-snug ${
          isDarkMode ? 'text-gray-200' : 'text-koni-neutral-700'
        }`}>
        {question}
      </p>

      <p className={`mt-2 text-xs ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`}>{t('chat_ask_hint')}</p>
    </div>
  );
}
