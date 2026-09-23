import { z } from 'zod';

export interface ActionSchema {
  name: string;
  description: string;
  schema: z.ZodType;
}

export const doneActionSchema: ActionSchema = {
  name: 'done',
  description:
    'End your part of the task and say why: reason "complete" when everything asked for is finished; "need_user" with a question when you cannot continue without a value or decision only the user can give (the run pauses, their answer continues it); "cannot_continue" when something outside your control blocks the task.',
  schema: z.object({
    text: z.string().describe('what was done, or what blocks the task'),
    reason: z.enum(['complete', 'need_user', 'cannot_continue']).default('complete'),
    question: z.string().default('').describe('the question for the user when reason is need_user'),
  }),
};

// Basic Navigation Actions
export const searchGoogleActionSchema: ActionSchema = {
  name: 'search_google',
  description:
    'Search the query in Google in the current tab, the query should be a search query like humans search in Google, concrete and not vague or super long. More the single most important items.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    query: z.string(),
  }),
};

export const goToUrlActionSchema: ActionSchema = {
  name: 'go_to_url',
  description: 'Navigate to URL in the current tab',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    url: z.string(),
  }),
};

export const goBackActionSchema: ActionSchema = {
  name: 'go_back',
  description: 'Go back to the previous page',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
  }),
};

export const clickElementActionSchema: ActionSchema = {
  name: 'click_element',
  description: 'Click element by index',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z
      .union([z.number().int(), z.string()])
      .describe("index of the element, or the control's field id when the observation shows one (field=…)"),
    xpath: z.string().nullable().optional().describe('xpath of the element'),
    // confirm/prompt dialogs are auto-CANCELLED by default (safe side). After
    // reading the reported dialog text, the agent may consciously retry.
    force: z
      .boolean()
      .nullable()
      .optional()
      .describe(
        'set true ONLY to retry a click whose confirm/prompt dialog was auto-cancelled: ' +
          'the dialog this click triggers will be ACCEPTED instead. Decide from the dialog text first.',
      ),
  }),
};

export const inputTextActionSchema: ActionSchema = {
  name: 'input_text',
  description: 'Input text into an interactive input element',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z
      .union([z.number().int(), z.string()])
      .describe("index of the element, or the control's field id when the observation shows one (field=…)"),
    // optional so a doc_ref-only call passes validation (doc_ref supersedes text)
    text: z.string().optional().default('').describe('text to input (may be omitted when doc_ref is given)'),
    xpath: z.string().nullable().optional().describe('xpath of the element'),
    // reference-based value transfer (SmartResume-style): point at a document
    // cell instead of retyping it — the executor pastes the original text
    doc_ref: z
      .string()
      .nullable()
      .optional()
      .describe(
        'attached-document table cell reference like "t1r2c3" (table 1, row 2, cell 3): the system pastes ' +
          "that cell's ORIGINAL text and `text` is ignored. ALWAYS prefer this over retyping a " +
          'value that appears in a document table',
      ),
  }),
};

// Tab Management Actions
export const switchTabActionSchema: ActionSchema = {
  name: 'switch_tab',
  description: 'Switch to tab by tab id',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    tab_id: z.number().int().describe('id of the tab to switch to'),
  }),
};

export const openTabActionSchema: ActionSchema = {
  name: 'open_tab',
  description: 'Open URL in new tab',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    url: z.string().describe('url to open'),
  }),
};

export const closeTabActionSchema: ActionSchema = {
  name: 'close_tab',
  description: 'Close tab by tab id',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    tab_id: z.number().int().describe('id of the tab'),
  }),
};

// Content Actions, not used currently
// export const extractContentActionSchema: ActionSchema = {
//   name: 'extract_content',
//   description:
//     'Extract page content to retrieve specific information from the page, e.g. all company names, a specific description, all information about, links with companies in structured format or simply links',
//   schema: z.object({
//     goal: z.string(),
//   }),
// };

// Cache Actions
export const cacheContentActionSchema: ActionSchema = {
  name: 'cache_content',
  description: 'Cache what you have found so far from the current page for future use',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    content: z.string().default('').describe('content to cache'),
  }),
};

export const scrollToPercentActionSchema: ActionSchema = {
  name: 'scroll_to_percent',
  description:
    'Scrolls to a particular vertical percentage of the document or an element. If no index of element is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    yPercent: z.number().int().describe('percentage to scroll to - min 0, max 100; 0 is top, 100 is bottom'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToTopActionSchema: ActionSchema = {
  name: 'scroll_to_top',
  description: 'Scroll the document in the window or an element to the top',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToBottomActionSchema: ActionSchema = {
  name: 'scroll_to_bottom',
  description: 'Scroll the document in the window or an element to the bottom',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const previousPageActionSchema: ActionSchema = {
  name: 'previous_page',
  description:
    'Scroll the document in the window or an element to the previous page. If no index is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const nextPageActionSchema: ActionSchema = {
  name: 'next_page',
  description:
    'Scroll the document in the window or an element to the next page. If no index is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToTextActionSchema: ActionSchema = {
  name: 'scroll_to_text',
  description: 'If you dont find something which you want to interact with in current viewport, try to scroll to it',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    text: z.string().describe('text to scroll to'),
    nth: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('which occurrence of the text to scroll to (1-indexed, default: 1)'),
  }),
};

export const sendKeysActionSchema: ActionSchema = {
  name: 'send_keys',
  description:
    'Send strings of special keys like Backspace, Insert, PageDown, Delete, Enter. Shortcuts such as `Control+o`, `Control+Shift+T` are supported as well. This gets used in keyboard press. Be aware of different operating systems and their shortcuts',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    keys: z.string().describe('keys to send'),
  }),
};

export const getDropdownOptionsActionSchema: ActionSchema = {
  name: 'get_dropdown_options',
  description: 'Get all options from a native dropdown',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z
      .union([z.number().int(), z.string()])
      .describe("index of the dropdown element, or the control's field id when the observation shows one (field=…)"),
  }),
};

export const selectDropdownOptionActionSchema: ActionSchema = {
  name: 'select_dropdown_option',
  description: 'Select dropdown option for interactive element index by the text of the option you want to select',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z
      .union([z.number().int(), z.string()])
      .describe("index of the dropdown element, or the control's field id when the observation shows one (field=…)"),
    text: z.string().describe('text of the option'),
  }),
};

export const waitActionSchema: ActionSchema = {
  name: 'wait',
  description: 'Wait for x seconds default 3, do NOT use this action unless user asks to wait explicitly',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    seconds: z.number().int().default(3).describe('amount of seconds'),
  }),
};

// Attached document actions (doc store, M3)
export const searchDocActionSchema: ActionSchema = {
  name: 'search_doc',
  description:
    'Search the attached documents for lines containing the given keywords. Use 2-3 content words likely to appear IN the document (e.g. a field label plus a value). Returns ranked matching lines with their table ids; follow up with read_table for a whole table.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    query: z.string().describe('space-separated search terms'),
  }),
};

export const readTableActionSchema: ActionSchema = {
  name: 'read_table',
  description:
    'Read one whole table from the attached documents by its table id (e.g. "t3" or nested "t3-1") as listed in the document TOC or returned by search_doc. Use for whole-table questions or when search results are ambiguous.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    tableId: z.string().describe('table id from the document TOC, e.g. t3 or t3-1'),
  }),
};

// ask_user (Wave 3): mid-task question to the user. Setting the question ends
// the run as a clean 'awaiting_user' terminal (executor) after dropping the
// rest of the action batch (navigator) — no "ask then submit anyway".
export const askUserActionSchema: ActionSchema = {
  name: 'ask_user',
  description:
    'Ask the user a question and stop to wait for their typed answer. Use ONLY when you are blocked, when required information is missing, or BEFORE an irreversible action (submitting a form, making a payment, sending a message/email). Never use it for routine progress updates. Any actions listed after ask_user in the same sequence are discarded, and execution stops until the user replies.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    question: z.string().describe('the question to ask the user'),
  }),
};

export const viewDocActionSchema: ActionSchema = {
  name: 'view_doc',
  description:
    'Show one page of an attached PDF as an image in the sticky slot. The slot holds exactly ONE page and is re-sent with every step until you call view_doc with another page (goto semantics, no next/prev). Page numbers match the "pN" ids in the document TOC.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    page: z.number().int().describe('1-based page number to show'),
    doc: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('1-based ordinal among the attached PDF documents (default: 1, the first PDF)'),
  }),
};
