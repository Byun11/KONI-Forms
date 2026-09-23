import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { FaMicrophone, FaStop } from 'react-icons/fa';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';
import { FiPaperclip, FiArrowUp, FiPlay } from 'react-icons/fi';
import { t } from '@extension/i18n';
import ModeSelector from './ModeSelector';
import { OFFICE_EXTENSIONS, isOfficeDocument, extractDocxText, extractHwpxText } from '../lib/officeText';
import { parseOfficeDocument, type DocParseResult } from '../lib/docParse';
import { parsePdf, PdfPageLimitError } from '../lib/pdfParse';
import { shouldInlineDoc, isDocPayloadWithinLimit, formatDocNote, type AttachedDocPayload } from '../lib/docAttach';

// Plain-text formats are read as-is; office documents (.docx/.hwpx) and PDFs
// are parsed client-side. Those files can legitimately be larger, so they get
// a bigger cap.
const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.xml', '.yaml', '.yml'];
const PDF_EXTENSION = '.pdf';
const ALLOWED_EXTENSIONS = [...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS, PDF_EXTENSION];
const TEXT_MAX_BYTES = 1024 * 1024; // 1MB
const OFFICE_MAX_BYTES = 20 * 1024 * 1024; // 20MB

interface ChatInputProps {
  onSendMessage: (text: string, displayText?: string, docs?: AttachedDocPayload[]) => void;
  onStopTask: () => void;
  onMicClick?: () => void;
  isRecording?: boolean;
  isProcessingSpeech?: boolean;
  disabled: boolean;
  showStopButton: boolean;
  setContent?: (setter: (text: string) => void) => void;
  isDarkMode?: boolean;
  // Historical session ID - if provided, shows replay button instead of send button
  historicalSessionId?: string | null;
  onReplay?: (sessionId: string) => void;
}

// File attachment interface. Exactly one of three shapes:
// - inline file: `content` holds the text that goes into <nano_attached_files>
//   (plain-text files, and office docs small enough for the fast path);
// - store-path doc (big office docs, every PDF): `parse` holds the structured
//   parse that travels as the task's `docs` payload, `content` stays empty;
// - failed attachment: `error` is set, the chip shows it, nothing is sent.
type AttachError = 'parseFailed' | 'tooLarge' | 'tooManyPages';

interface AttachedFile {
  name: string;
  content: string;
  type: string;
  parse?: DocParseResult;
  error?: AttachError;
}

function attachErrorText(error: AttachError): string {
  if (error === 'tooLarge') return t('chat_attach_errors_tooLarge');
  if (error === 'tooManyPages') return t('chat_attach_errors_tooManyPages');
  return t('chat_attach_errors_parseFailed');
}

/** Chip/file-list summary of a store-path parse: page count for PDFs, table count for office docs. */
function docParseSummary(parse: DocParseResult): string {
  return parse.kind === 'pdf'
    ? t('chat_attach_docPages', String(parse.pages?.length ?? 0))
    : t('chat_attach_docTables', String(parse.stats.tables));
}

export default function ChatInput({
  onSendMessage,
  onStopTask,
  onMicClick,
  isRecording = false,
  isProcessingSpeech = false,
  disabled,
  showStopButton,
  setContent,
  isDarkMode = false,
  historicalSessionId,
  onReplay,
}: ChatInputProps) {
  const [text, setText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  // Failed attachments (error chips) contribute nothing to the message, so
  // they don't enable the send button by themselves.
  const isSendButtonDisabled = useMemo(
    () => disabled || (text.trim() === '' && attachedFiles.every(file => file.error !== undefined)),
    [disabled, text, attachedFiles],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Claude-style rotating placeholder hint (only relevant while the field is empty)
  const rotatingPlaceholders = useMemo(() => [t('chat_input_placeholder'), t('chat_input_slashHint')], []);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  useEffect(() => {
    if (rotatingPlaceholders.length <= 1) return;
    const interval = setInterval(() => {
      setPlaceholderIndex(prev => (prev + 1) % rotatingPlaceholders.length);
    }, 4000);
    return () => clearInterval(interval);
  }, [rotatingPlaceholders.length]);

  // Handle text changes and resize textarea
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setText(newText);

    // Resize textarea
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`;
    }
  };

  // Expose a method to set content from outside
  useEffect(() => {
    if (setContent) {
      setContent(setText);
    }
  }, [setContent]);

  // Keep the composer at its compact one-line height whenever it's empty
  useEffect(() => {
    // No measuring on mount: at panel-open time the layout isn't settled yet, so
    // scrollHeight reads too large and pins the box tall until the first keystroke.
    // rows={1} already gives the correct compact height with zero JS; we only need
    // to CLEAR the inline height when the text is emptied programmatically
    // (send/submit bypasses onChange), so the box returns to one line.
    const textarea = textareaRef.current;
    if (textarea && text === '') {
      textarea.style.height = '';
    }
  }, [text]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedText = text.trim();

      // Failed attachments (error chips) are never sent.
      const sendableFiles = attachedFiles.filter(file => !file.error);
      const inlineFiles = sendableFiles.filter(file => !file.parse);
      const storeDocs = sendableFiles.filter(
        (file): file is AttachedFile & { parse: DocParseResult } => file.parse !== undefined,
      );

      if (trimmedText || sendableFiles.length > 0) {
        let messageContent = trimmedText;
        let displayContent = trimmedText;

        // Store-path office docs: the message text carries only a one-line note
        // per document; the full structured parse travels separately as the
        // task's `docs` payload (doc store — never inlined into the prompt).
        if (storeDocs.length > 0) {
          const notes = storeDocs.map(file => formatDocNote(file.name, file.parse)).join('\n');
          messageContent = messageContent ? `${messageContent}\n\n${notes}` : notes;
        }

        // Security: Clearly separate user input from file content
        // The background service will sanitize file content using guardrails
        if (inlineFiles.length > 0) {
          const fileContents = inlineFiles
            .map(file => {
              // Tag file content for background service to identify and sanitize
              return `\n\n<nano_file_content type="file" name="${file.name}">\n${file.content}\n</nano_file_content>`;
            })
            .join('\n');

          // Combine user message with tagged file content (for background service)
          messageContent = messageContent
            ? `${messageContent}\n\n<nano_attached_files>${fileContents}</nano_attached_files>`
            : `<nano_attached_files>${fileContents}</nano_attached_files>`;
        }

        if (sendableFiles.length > 0) {
          // Create display version with only filenames (for UI)
          const fileList = sendableFiles
            .map(file => `📎 ${file.name}${file.parse ? ` · ${docParseSummary(file.parse)}` : ''}`)
            .join('\n');
          displayContent = trimmedText ? `${trimmedText}\n\n${fileList}` : fileList;
        }

        onSendMessage(
          messageContent,
          displayContent,
          storeDocs.length > 0 ? storeDocs.map(file => ({ name: file.name, parse: file.parse })) : undefined,
        );
        setText('');
        setAttachedFiles([]);
      }
    },
    [text, attachedFiles, onSendMessage],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSubmit(e);
      }
    },
    [handleSubmit],
  );

  const handleReplay = useCallback(() => {
    if (historicalSessionId && onReplay) {
      onReplay(historicalSessionId);
    }
  }, [historicalSessionId, onReplay]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const processFiles = useCallback(async (fileList: File[]) => {
    if (fileList.length === 0) return;

    const newFiles: AttachedFile[] = [];

    for (const file of fileList) {
      const fileExt = '.' + file.name.split('.').pop()?.toLowerCase();

      // Check if file type is allowed
      if (!ALLOWED_EXTENSIONS.includes(fileExt)) {
        console.warn(`File type ${fileExt} not supported.`);
        continue;
      }

      // Office documents and PDFs get a larger size budget than plain text files
      const isOffice = isOfficeDocument(fileExt);
      const isPdf = fileExt === PDF_EXTENSION;
      const maxBytes = isOffice || isPdf ? OFFICE_MAX_BYTES : TEXT_MAX_BYTES;
      if (file.size > maxBytes) {
        console.warn(`File ${file.name} is too large. Maximum size is ${Math.round(maxBytes / (1024 * 1024))}MB.`);
        continue;
      }

      const type = file.type || 'text/plain';
      try {
        if (isPdf) {
          // PDFs are rendered ONCE here (page images + text-layer lines) and
          // ALWAYS take the store path — the page images only work through
          // the doc store's view_doc sticky slot, never inline.
          const buffer = await file.arrayBuffer();
          const parse = await parsePdf(buffer);
          if (isDocPayloadWithinLimit(parse)) {
            newFiles.push({ name: file.name, content: '', type, parse });
          } else {
            newFiles.push({ name: file.name, content: '', type, error: 'tooLarge' });
          }
        } else if (isOffice) {
          // Office documents are ZIP+XML: run the structured parser at attach
          // time and decide the path by size. Small docs keep the inline fast
          // path (plain extracted text); big docs go to the doc store and only
          // the parse travels (a 100-page document is NEVER inlined).
          const buffer = await file.arrayBuffer();
          const parse = await parseOfficeDocument(buffer, fileExt);
          if (shouldInlineDoc(parse)) {
            // Markdown keeps table rows intact; the tag-strip text is the fallback.
            const content =
              parse.markdown || (fileExt === '.docx' ? await extractDocxText(buffer) : await extractHwpxText(buffer));
            newFiles.push({ name: file.name, content, type });
          } else if (isDocPayloadWithinLimit(parse)) {
            newFiles.push({ name: file.name, content: '', type, parse });
          } else {
            // Oversized parse: keep a visible error chip instead of silently dropping.
            newFiles.push({ name: file.name, content: '', type, error: 'tooLarge' });
          }
        } else {
          // Plain-text formats are read as-is (unchanged behavior).
          newFiles.push({ name: file.name, content: await file.text(), type });
        }
      } catch (error) {
        console.error(`Error reading file ${file.name}:`, error);
        if (isPdf) {
          // Over the page cap and broken PDFs each get their own visible chip error.
          newFiles.push({
            name: file.name,
            content: '',
            type,
            error: error instanceof PdfPageLimitError ? 'tooManyPages' : 'parseFailed',
          });
        } else if (isOffice) {
          // A broken office file also gets a visible error chip.
          newFiles.push({ name: file.name, content: '', type, error: 'parseFailed' });
        }
      }
    }

    // One document, both representations: a PDF attached alongside an office
    // file of the same name is that file's render, so fold its page images into
    // the office document instead of adding a second document. The agent then
    // has the parsed tables (search_doc / read_table) and the page images
    // (view_doc) for one document — no document-number prefix on coordinates,
    // which is what a second entry would have forced.
    const baseName = (n: string) => n.replace(/\.[^.]+$/, '');
    for (let i = newFiles.length - 1; i >= 0; i--) {
      const pdf = newFiles[i];
      if (!pdf.parse || pdf.parse.kind !== 'pdf' || !pdf.parse.pages?.length) continue;
      const host = newFiles.find(
        f => f !== pdf && f.parse && f.parse.kind !== 'pdf' && baseName(f.name) === baseName(pdf.name),
      );
      if (!host?.parse) continue;
      host.parse = { ...host.parse, pages: pdf.parse.pages };
      newFiles.splice(i, 1);
    }

    if (newFiles.length > 0) {
      setAttachedFiles(prev => [...prev, ...newFiles]);
    }
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files) await processFiles(Array.from(files));
      // Reset so picking the same file again still fires onChange
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [processFiles],
  );

  // Drag-and-drop onto the input, same path as the file picker.
  const [isDragging, setIsDragging] = useState(false);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (disabled) return;
      const dropped = Array.from(e.dataTransfer.files);
      if (dropped.length) void processFiles(dropped);
    },
    [processFiles, disabled],
  );
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      // Only file drags; a text-selection drag keeps its default behaviour.
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      // Always hold a file drag, even while a task runs, or Chrome opens the file in place
      // of the panel when it is dropped.
      e.preventDefault();
      if (disabled) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      setIsDragging(true);
    },
    [disabled],
  );

  const handleRemoveFile = useCallback((index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <form
      onSubmit={handleSubmit}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={e => {
        // Crossing onto a child (the text box, a button) also fires dragleave; clear only
        // when the pointer actually leaves the form, so the highlight does not flicker.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsDragging(false);
      }}
      className={`overflow-hidden rounded-2xl border transition-colors ${isDragging ? (isDarkMode ? 'border-sky-400 ring-2 ring-sky-900' : 'border-koni-primary-600 ring-2 ring-koni-primary-100') : isDarkMode ? 'border-slate-700 focus-within:border-sky-400' : 'border-koni-neutral-200 focus-within:border-koni-primary-600 focus-within:ring-2 focus-within:ring-koni-primary-50'} ${disabled ? 'cursor-not-allowed' : ''}`}
      aria-label={t('chat_input_form')}>
      <div className="flex flex-col">
        {/* File attachments display */}
        {attachedFiles.length > 0 && (
          <div
            className={`flex flex-wrap gap-2 border-b p-2 ${
              isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-koni-neutral-200 bg-white'
            }`}>
            {attachedFiles.map((file, index) => (
              <div
                key={index}
                className={`flex items-center gap-1 rounded-full border px-2 py-1 text-xs ${
                  file.error
                    ? isDarkMode
                      ? 'border-red-700 bg-red-950 text-red-300'
                      : 'border-red-300 bg-red-50 text-red-700'
                    : isDarkMode
                      ? 'border-slate-600 bg-slate-700 text-gray-300'
                      : 'border-koni-neutral-200 bg-koni-neutral-100 text-koni-neutral-700'
                }`}
                title={file.error ? attachErrorText(file.error) : undefined}>
                <span className="text-xs">{file.error ? '⚠️' : '📎'}</span>
                <span className="max-w-[150px] truncate">{file.name}</span>
                {/* Store-path parse summary (tables / PDF pages) or the attach error */}
                {file.parse && <span className="whitespace-nowrap opacity-70">· {docParseSummary(file.parse)}</span>}
                {file.error && <span className="whitespace-nowrap">· {attachErrorText(file.error)}</span>}
                <button
                  type="button"
                  onClick={() => handleRemoveFile(index)}
                  className={`ml-1 rounded-full transition-colors ${
                    isDarkMode ? 'hover:bg-slate-600' : 'hover:bg-koni-neutral-200'
                  }`}
                  aria-label={`Remove ${file.name}`}>
                  <span className="text-xs">✕</span>
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          aria-disabled={disabled}
          rows={1}
          className={`w-full resize-none border-none p-2 focus:outline-none placeholder:text-koni-neutral-500 ${
            disabled
              ? isDarkMode
                ? 'cursor-not-allowed bg-slate-800 text-gray-400'
                : 'cursor-not-allowed bg-white text-koni-neutral-500'
              : isDarkMode
                ? 'bg-slate-800 text-gray-200'
                : 'bg-white text-koni-neutral-900'
          }`}
          placeholder={
            attachedFiles.length > 0 ? 'Add a message (optional)...' : rotatingPlaceholders[placeholderIndex]
          }
          aria-label={t('chat_input_editor')}
        />

        <div
          className={`flex items-center justify-between px-2 py-1.5 ${
            disabled ? (isDarkMode ? 'bg-slate-800' : 'bg-koni-neutral-100') : isDarkMode ? 'bg-slate-800' : 'bg-white'
          }`}>
          <div className="flex gap-2 text-gray-500">
            {/* File attachment button */}
            <button
              type="button"
              onClick={handleFileSelect}
              disabled={disabled}
              aria-label="Attach files"
              title="Attach documents (docx, hwpx, pdf) or text files (txt, md, json, csv, etc.)"
              className={`rounded-md p-1.5 transition-colors ${
                disabled
                  ? 'cursor-not-allowed opacity-50'
                  : isDarkMode
                    ? 'text-gray-400 hover:bg-slate-700 hover:text-gray-200'
                    : 'text-koni-neutral-500 hover:bg-koni-neutral-100 hover:text-koni-neutral-700'
              }`}>
              <FiPaperclip size={16} />
            </button>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml,.docx,.hwpx,.pdf"
              onChange={handleFileChange}
              className="hidden"
              aria-hidden="true"
            />

            {onMicClick && (
              <button
                type="button"
                onClick={onMicClick}
                disabled={disabled || isProcessingSpeech}
                aria-label={
                  isProcessingSpeech
                    ? t('chat_stt_processing')
                    : isRecording
                      ? t('chat_stt_recording_stop')
                      : t('chat_stt_input_start')
                }
                className={`rounded-md p-1.5 transition-colors ${
                  disabled || isProcessingSpeech
                    ? 'cursor-not-allowed opacity-50'
                    : isRecording
                      ? 'bg-red-500 text-white hover:bg-red-600'
                      : isDarkMode
                        ? 'text-gray-400 hover:bg-slate-700 hover:text-gray-200'
                        : 'text-koni-neutral-500 hover:bg-koni-neutral-100 hover:text-koni-neutral-700'
                }`}>
                {isProcessingSpeech ? (
                  <AiOutlineLoading3Quarters className="size-4 animate-spin" />
                ) : (
                  <FaMicrophone className={`size-4 ${isRecording ? 'animate-pulse' : ''}`} />
                )}
              </button>
            )}

            {/* Execution mode: auto run vs plan approval (Claude-style) */}
            <ModeSelector isDarkMode={isDarkMode} />
          </div>

          {showStopButton ? (
            <button
              type="button"
              onClick={onStopTask}
              aria-label={t('chat_buttons_stop')}
              title={t('chat_buttons_stop')}
              className="flex size-8 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600">
              <FaStop size={12} />
            </button>
          ) : historicalSessionId ? (
            <button
              type="button"
              onClick={handleReplay}
              disabled={!historicalSessionId}
              aria-disabled={!historicalSessionId}
              aria-label={t('chat_buttons_replay')}
              title={t('chat_buttons_replay')}
              className={`flex size-8 items-center justify-center rounded-full bg-emerald-600 text-white transition-colors hover:enabled:bg-emerald-700 ${!historicalSessionId ? 'cursor-not-allowed opacity-50' : ''}`}>
              <FiPlay size={15} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={isSendButtonDisabled}
              aria-disabled={isSendButtonDisabled}
              aria-label={t('chat_buttons_send')}
              title={t('chat_buttons_send')}
              className={`flex size-8 items-center justify-center rounded-full transition-colors ${
                isSendButtonDisabled
                  ? isDarkMode
                    ? 'cursor-not-allowed bg-slate-700 text-slate-500'
                    : 'cursor-not-allowed bg-koni-neutral-200 text-koni-neutral-400'
                  : 'bg-koni-primary-600 text-white hover:bg-koni-primary-700'
              }`}>
              <FiArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
