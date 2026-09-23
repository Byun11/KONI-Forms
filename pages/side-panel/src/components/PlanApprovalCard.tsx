import { FiCheck, FiX } from 'react-icons/fi';
import { t } from '@extension/i18n';

interface PlanApprovalCardProps {
  plan: string;
  onApprove: () => void;
  onReject: () => void;
  isDarkMode?: boolean;
}

/**
 * Split a planner's next_steps blob into individual steps for a Claude-style
 * numbered list. Handles "1) foo 2) bar", "1. foo 2. bar", newline-separated
 * and bulleted forms; falls back to the raw text when nothing splits.
 */
function splitSteps(plan: string): string[] {
  const stripMarker = (s: string) => s.replace(/^(?:\d{1,2}[).]|[-•])\s*/, '').trim();

  // Try inline numbering first: "1) … 2) …" / "1. … 2. …"
  const inline = plan
    .split(/(?=(?:^|\s)\d{1,2}[).]\s)/)
    .map(s => s.trim())
    .filter(Boolean);
  if (inline.length > 1) return inline.map(stripMarker);

  // Then line breaks / bullets
  const lines = plan
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  if (lines.length > 1) return lines.map(stripMarker);

  return [plan.trim()];
}

/**
 * Claude-style plan approval card: shown while the executor is paused on
 * PLAN_WAIT. Approve resumes the task; Reject cancels it.
 */
export default function PlanApprovalCard({ plan, onApprove, onReject, isDarkMode = false }: PlanApprovalCardProps) {
  const steps = splitSteps(plan);

  return (
    <div
      className={`rounded-xl border p-3 shadow-sm ${
        isDarkMode ? 'border-slate-600 bg-slate-800' : 'border-koni-neutral-200 bg-white'
      }`}>
      <p className={`mb-2 text-sm font-semibold ${isDarkMode ? 'text-gray-100' : 'text-koni-navy-900'}`}>
        {t('chat_plan_title')}
      </p>

      <div className="max-h-48 space-y-1.5 overflow-y-auto">
        {steps.length > 1 ? (
          steps.map((step, i) => (
            // Steps have no stable identity beyond their position in this plan
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="flex gap-2">
              <span
                className={`w-4 shrink-0 text-right text-sm font-medium tabular-nums ${
                  isDarkMode ? 'text-sky-400' : 'text-koni-primary-600'
                }`}>
                {i + 1}.
              </span>
              <span className={`text-sm leading-snug ${isDarkMode ? 'text-gray-200' : 'text-koni-neutral-800'}`}>
                {step}
              </span>
            </div>
          ))
        ) : (
          <p
            className={`whitespace-pre-wrap text-sm leading-snug ${isDarkMode ? 'text-gray-200' : 'text-koni-neutral-800'}`}>
            {steps[0]}
          </p>
        )}
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onReject}
          className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-sm transition-colors ${
            isDarkMode ? 'text-gray-300 hover:bg-slate-700' : 'text-koni-neutral-600 hover:bg-koni-neutral-100'
          }`}>
          <FiX size={14} />
          {t('chat_plan_reject')}
        </button>
        <button
          type="button"
          onClick={onApprove}
          className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium text-white transition-colors ${
            isDarkMode ? 'bg-sky-600 hover:bg-sky-700' : 'bg-koni-primary-600 hover:bg-koni-primary-700'
          }`}>
          <FiCheck size={14} />
          {t('chat_plan_approve')}
        </button>
      </div>
    </div>
  );
}
