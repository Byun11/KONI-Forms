import type { Message } from '@extension/storage';
import { ACTOR_PROFILES } from '../types/message';
import { memo, useState } from 'react';
import {
  FiCheck,
  FiX,
  FiGlobe,
  FiSearch,
  FiArrowLeft,
  FiClock,
  FiMousePointer,
  FiEdit3,
  FiCommand,
  FiLayers,
  FiPlusSquare,
  FiXSquare,
  FiBookmark,
  FiMove,
  FiChevronsUp,
  FiChevronsDown,
  FiChevronUp,
  FiChevronDown,
  FiList,
  FiCheckSquare,
  FiFlag,
  FiZap,
  FiSettings,
  FiFileText,
} from 'react-icons/fi';
import type { IconType } from 'react-icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ---------------------------------------------------------------------------
// Action icon map
// ---------------------------------------------------------------------------
const ACTION_ICONS: Record<string, IconType> = {
  go_to_url: FiGlobe,
  search_google: FiSearch,
  scroll_to_text: FiSearch,
  go_back: FiArrowLeft,
  wait: FiClock,
  click_element: FiMousePointer,
  input_text: FiEdit3,
  send_keys: FiCommand,
  switch_tab: FiLayers,
  open_tab: FiPlusSquare,
  close_tab: FiXSquare,
  cache_content: FiBookmark,
  scroll_to_percent: FiMove,
  scroll_to_top: FiChevronsUp,
  scroll_to_bottom: FiChevronsDown,
  previous_page: FiChevronUp,
  next_page: FiChevronDown,
  get_dropdown_options: FiList,
  select_dropdown_option: FiCheckSquare,
  done: FiFlag,
};

function getActionIcon(actionName?: string): IconType {
  if (actionName && actionName in ACTION_ICONS) {
    return ACTION_ICONS[actionName];
  }
  return FiZap;
}

// ---------------------------------------------------------------------------
// Segment types for grouping navigator/validator items
// ---------------------------------------------------------------------------
type InlineSegment = { kind: 'inline'; item: Message };
type BatchSegment = { kind: 'batch'; items: Message[] };
type ProgressSegment = { kind: 'progress' };
type Segment = InlineSegment | BatchSegment | ProgressSegment;

function buildSegments(items: Message[]): Segment[] {
  const segments: Segment[] = [];
  let currentBatch: Message[] = [];

  function flushBatch() {
    if (currentBatch.length === 0) return;
    const batch = currentBatch;
    currentBatch = [];
    // A batch with actionCount>1 on first item, or multiple items → BatchCard
    const firstActionCount = batch[0]?.actionCount ?? 1;
    if (batch.length > 1 || firstActionCount > 1) {
      segments.push({ kind: 'batch', items: batch });
    } else {
      segments.push({ kind: 'inline', item: batch[0] });
    }
  }

  for (const item of items) {
    if (item.content === 'Showing progress...') {
      flushBatch();
      segments.push({ kind: 'progress' });
    } else if (item.actionIndex === 0) {
      // Start of a new batch
      flushBatch();
      currentBatch = [item];
    } else if (typeof item.actionIndex === 'number' && item.actionIndex > 0) {
      // Continuation of current batch
      currentBatch.push(item);
    } else {
      // No actionIndex (e.g. step.fail standalone message)
      flushBatch();
      segments.push({ kind: 'inline', item });
    }
  }
  flushBatch();
  return segments;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface MessageListProps {
  messages: Message[];
  isDarkMode?: boolean;
}

interface ActorGroup {
  actor: string;
  items: Message[];
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------
export default memo(function MessageList({ messages, isDarkMode = false }: MessageListProps) {
  const groups: ActorGroup[] = [];
  for (const message of messages) {
    if (!message.actor) continue;
    const last = groups[groups.length - 1];
    if (last && last.actor === message.actor) {
      last.items.push(message);
    } else {
      groups.push({ actor: message.actor, items: [message] });
    }
  }

  // Merge consecutive non-user groups into a single timeline run
  type TimelineRun = { kind: 'timeline'; groups: ActorGroup[] };
  type UserRun = { kind: 'user'; items: Message[] };
  type Run = TimelineRun | UserRun;

  const runs: Run[] = [];
  for (const group of groups) {
    if (group.actor === 'user') {
      runs.push({ kind: 'user', items: group.items });
    } else {
      const last = runs[runs.length - 1];
      if (last && last.kind === 'timeline') {
        last.groups.push(group);
      } else {
        runs.push({ kind: 'timeline', groups: [group] });
      }
    }
  }

  return (
    <div className="max-w-full">
      {runs.map((run, index) =>
        run.kind === 'user' ? (
          <UserGroup key={`u-${index}`} items={run.items} isDarkMode={isDarkMode} />
        ) : (
          <TimelineBlock key={`t-${index}`} groups={run.groups} isDarkMode={isDarkMode} />
        ),
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// User bubble (unchanged)
// ---------------------------------------------------------------------------
function UserGroup({ items, isDarkMode }: { items: Message[]; isDarkMode: boolean }) {
  return (
    <div className="space-y-1 pb-3">
      {items.map((message, index) => (
        <div key={index} className="flex justify-end">
          <div
            title={formatTimestamp(message.timestamp)}
            className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm ${
              isDarkMode ? 'bg-slate-700 text-gray-100' : 'bg-koni-neutral-100 text-koni-neutral-900'
            }`}>
            {message.content}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Continuous timeline block for one or more consecutive agent groups
// ---------------------------------------------------------------------------
function TimelineBlock({ groups, isDarkMode }: { groups: ActorGroup[]; isDarkMode: boolean }) {
  return (
    <div>
      {groups.map((group, gIdx) => {
        const isPlanner = group.actor === 'planner';
        const prevActor = gIdx > 0 ? groups[gIdx - 1].actor : null;
        const showCaption = prevActor !== group.actor;
        const profile = ACTOR_PROFILES[group.actor as keyof typeof ACTOR_PROFILES];
        const actorLabel = profile?.name ?? group.actor;

        if (isPlanner) {
          // Planner: each message is a timeline row with FiFileText node
          return (
            <div key={gIdx}>
              {showCaption && <ActorCaption label={actorLabel} isDarkMode={isDarkMode} />}
              {group.items.map((message, mIdx) => {
                const isProgress = message.content === 'Showing progress...';
                if (isProgress) {
                  return (
                    <TimelineRow key={mIdx} nodeKind="progress" isDarkMode={isDarkMode}>
                      <div className="py-1">
                        <ProgressBar isDarkMode={isDarkMode} />
                      </div>
                    </TimelineRow>
                  );
                }
                return (
                  <TimelineRow key={mIdx} nodeKind="planner" isDarkMode={isDarkMode}>
                    <MarkdownText content={message.content} isDarkMode={isDarkMode} />
                  </TimelineRow>
                );
              })}
            </div>
          );
        }

        // Navigator / validator: use buildSegments
        const segments = buildSegments(group.items);
        return (
          <div key={gIdx}>
            {showCaption && <ActorCaption label={actorLabel} isDarkMode={isDarkMode} />}
            {segments.map((seg, sIdx) => {
              if (seg.kind === 'progress') {
                return (
                  <TimelineRow key={sIdx} nodeKind="progress" isDarkMode={isDarkMode}>
                    <div className="py-1">
                      <ProgressBar isDarkMode={isDarkMode} />
                    </div>
                  </TimelineRow>
                );
              }
              if (seg.kind === 'batch') {
                return (
                  <TimelineRow key={sIdx} nodeKind="batch" isDarkMode={isDarkMode}>
                    <BatchCard items={seg.items} isDarkMode={isDarkMode} />
                  </TimelineRow>
                );
              }
              // inline action
              const item = seg.item;
              const isFail = item.state === 'act.fail' || item.state === 'step.fail';
              return (
                <TimelineRow
                  key={sIdx}
                  nodeKind="action"
                  actionName={item.actionName}
                  isFail={isFail}
                  isDarkMode={isDarkMode}>
                  <InlineActionContent item={item} isDarkMode={isDarkMode} />
                </TimelineRow>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actor caption label (no node circle)
// ---------------------------------------------------------------------------
function ActorCaption({ label, isDarkMode }: { label: string; isDarkMode: boolean }) {
  return (
    <div className="flex gap-3">
      {/* gutter spacer — matches rail column width */}
      <div className="relative flex w-5 shrink-0 self-stretch justify-center">
        <span
          className={`absolute left-1/2 top-0 h-full w-px -translate-x-1/2 ${
            isDarkMode ? 'bg-slate-700' : 'bg-koni-neutral-200'
          }`}
        />
      </div>
      {/* label */}
      <div
        className={`min-w-0 flex-1 pb-1 pl-2 text-[10px] font-semibold uppercase tracking-wider ${
          isDarkMode ? 'text-gray-500' : 'text-koni-neutral-500'
        }`}>
        {label}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single timeline row: left rail + node + right content
// ---------------------------------------------------------------------------
type NodeKind = 'planner' | 'action' | 'batch' | 'progress';

interface TimelineRowProps {
  nodeKind: NodeKind;
  actionName?: string;
  isFail?: boolean;
  isDarkMode: boolean;
  children: React.ReactNode;
}

function TimelineRow({ nodeKind, actionName, isFail = false, isDarkMode, children }: TimelineRowProps) {
  // Determine node icon
  let NodeIcon: IconType | null = null;
  if (nodeKind === 'planner') {
    NodeIcon = FiFileText;
  } else if (nodeKind === 'action') {
    NodeIcon = isFail ? FiX : getActionIcon(actionName);
  } else if (nodeKind === 'batch') {
    NodeIcon = FiSettings;
  }
  // progress: no icon, pulsing dot instead

  const railColor = isDarkMode ? 'bg-slate-700' : 'bg-koni-neutral-200';
  const nodeBorder = isFail
    ? isDarkMode
      ? 'border-red-500'
      : 'border-koni-danger'
    : isDarkMode
      ? 'border-slate-700'
      : 'border-koni-neutral-200';
  const nodeBg = isDarkMode ? 'bg-slate-800' : 'bg-white';
  const iconColor = isFail
    ? isDarkMode
      ? 'text-red-400'
      : 'text-koni-danger'
    : isDarkMode
      ? 'text-gray-400'
      : 'text-koni-neutral-500';

  return (
    <div className="flex gap-3">
      {/* LEFT GUTTER */}
      <div className="relative flex w-5 shrink-0 self-stretch justify-center">
        {/* continuous rail line */}
        <span className={`absolute left-1/2 top-0 h-full w-px -translate-x-1/2 ${railColor}`} />
        {/* node sitting on top of the line */}
        {nodeKind === 'progress' ? (
          <span className="relative z-10 mt-0.5 flex size-5 items-center justify-center">
            <span className="size-2 animate-pulse rounded-full bg-koni-primary-600" />
          </span>
        ) : (
          <span
            className={`relative z-10 mt-0.5 flex size-5 items-center justify-center rounded-full border ${nodeBorder} ${nodeBg}`}>
            {NodeIcon && <NodeIcon className={`size-3 ${iconColor}`} />}
          </span>
        )}
      </div>
      {/* RIGHT CONTENT */}
      <div className="min-w-0 flex-1 pb-3">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline action content (replaces ActionRow as timeline row content)
// ---------------------------------------------------------------------------
function InlineActionContent({ item, isDarkMode }: { item: Message; isDarkMode: boolean }) {
  // The timeline node already carries the action's type icon (and fail color),
  // so the row content is just the text — no redundant status glyph.
  return (
    <div
      className={`whitespace-pre-wrap break-words text-sm leading-relaxed tracking-[-0.01em] ${
        isDarkMode ? 'text-gray-300' : 'text-koni-neutral-700'
      }`}>
      {item.content}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single action row — still used inside BatchCard
// ---------------------------------------------------------------------------
function ActionRow({ item, isDarkMode }: { item: Message; isDarkMode: boolean }) {
  const isFail = item.state === 'act.fail' || item.state === 'step.fail';
  const TypeIcon = getActionIcon(item.actionName);

  return (
    <div className="flex items-start gap-2 py-1.5">
      {/* status glyph */}
      <span className="mt-0.5 shrink-0">
        {isFail ? (
          <FiX className={`size-3.5 ${isDarkMode ? 'text-red-400' : 'text-koni-danger'}`} />
        ) : (
          <FiCheck className={`size-3.5 ${isDarkMode ? 'text-green-400' : 'text-koni-success'}`} />
        )}
      </span>
      {/* type icon */}
      <span className="mt-0.5 shrink-0">
        <TypeIcon className={`size-3.5 ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`} />
      </span>
      {/* text */}
      <div
        className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed tracking-[-0.01em] ${
          isDarkMode ? 'text-gray-300' : 'text-koni-neutral-700'
        }`}>
        {item.content}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Batch card (collapsible)
// ---------------------------------------------------------------------------
function BatchCard({ items, isDarkMode }: { items: Message[]; isDarkMode: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const count = items[0]?.actionCount ?? items.length;
  const uniqueNames = Array.from(new Set(items.map(m => m.actionName).filter(Boolean))).join(', ');

  return (
    <div
      className={`rounded-md border-l-2 ${
        isDarkMode ? 'border-slate-600 bg-slate-800/30' : 'border-koni-neutral-300 bg-koni-neutral-50'
      }`}>
      {/* header */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className={`flex w-full items-center justify-between px-3 py-1.5 transition-colors ${
          isDarkMode ? 'hover:bg-slate-700/40' : 'hover:bg-koni-neutral-100/60'
        }`}>
        <span className={`text-xs font-medium ${isDarkMode ? 'text-gray-300' : 'text-koni-neutral-600'}`}>
          Batch — {count}/{count} actions
        </span>
        {expanded ? (
          <FiChevronUp className={`size-3.5 ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`} />
        ) : (
          <FiChevronDown className={`size-3.5 ${isDarkMode ? 'text-gray-400' : 'text-koni-neutral-500'}`} />
        )}
      </button>

      {/* rows + footer */}
      {expanded && (
        <>
          <div className="px-3 pb-1">
            {items.map((item, i) => (
              <ActionRow key={i} item={item} isDarkMode={isDarkMode} />
            ))}
          </div>
          {uniqueNames && (
            <div className={`px-3 pb-2 text-xs ${isDarkMode ? 'text-gray-500' : 'text-koni-neutral-500'}`}>
              Tool: {uniqueNames}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animated progress bar
// ---------------------------------------------------------------------------
function ProgressBar({ isDarkMode }: { isDarkMode: boolean }) {
  return (
    <div className={`h-1 overflow-hidden rounded ${isDarkMode ? 'bg-gray-700' : 'bg-koni-neutral-100'}`}>
      <div className="h-full animate-progress bg-koni-primary-600" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Planner markdown
// ---------------------------------------------------------------------------
function MarkdownText({ content, isDarkMode }: { content: string; isDarkMode: boolean }) {
  return (
    <div
      className={`text-sm leading-relaxed tracking-[-0.01em] ${
        isDarkMode ? 'text-gray-300' : 'text-koni-neutral-700'
      } [&_a]:text-koni-primary-600 [&_a]:underline [&_code]:rounded [&_code]:bg-black/5 [&_code]:px-1 [&_code]:text-[0.85em] [&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_strong]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timestamp formatter
// ---------------------------------------------------------------------------
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  const isToday = date.toDateString() === now.toDateString();

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const isThisYear = date.getFullYear() === now.getFullYear();

  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isToday) return timeStr;
  if (isYesterday) return `Yesterday, ${timeStr}`;
  if (isThisYear) return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
  return `${date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}, ${timeStr}`;
}
