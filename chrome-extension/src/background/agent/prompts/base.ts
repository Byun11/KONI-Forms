import { HumanMessage, type SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { wrapUntrustedContent } from '../messages/utils';
import { getStickyPage, formatStickyEmptyHint } from '../actions/docSearch';
import { createLogger } from '@src/background/log';

const logger = createLogger('BasePrompt');
/**
 * Abstract base class for all prompt types
 */
abstract class BasePrompt {
  /**
   * Returns the system message that defines the AI's role and behavior
   * @returns SystemMessage from LangChain
   */
  abstract getSystemMessage(): SystemMessage;

  /**
   * Returns the user message for the specific prompt type
   * @param context - Optional context data needed for generating the user message
   * @returns HumanMessage from LangChain
   */
  abstract getUserMessage(context: AgentContext): Promise<HumanMessage>;

  /**
   * Builds the user message containing the browser state
   * @param context - The agent context
   * @returns HumanMessage from LangChain
   */
  async buildBrowserStateUserMessage(context: AgentContext): Promise<HumanMessage> {
    const browserState = await context.browserContext.getState(context.options.useVision);
    const rawElementsText = browserState.elementTree.clickableElementsToString(context.options.includeAttributes);

    let formattedElementsText = '';
    if (rawElementsText !== '') {
      const scrollInfo = `[Scroll info of current page] window.scrollY: ${browserState.scrollY}, document.body.scrollHeight: ${browserState.scrollHeight}, window.visualViewport.height: ${browserState.visualViewportHeight}, visual viewport height as percentage of scrollable distance: ${Math.round((browserState.visualViewportHeight / (browserState.scrollHeight - browserState.visualViewportHeight)) * 100)}%\n`;
      logger.info(scrollInfo);
      // Run logs keep the observation the model saw (truncated) — without it
      // a wrong click ("index 0" = an unnamed modal close button) is invisible.
      logger.info('[State elements]\n' + rawElementsText.slice(0, 4000));
      const elementsText = wrapUntrustedContent(rawElementsText);
      formattedElementsText = `${scrollInfo}[Start of page]\n${elementsText}\n[End of page]\n`;
    } else {
      formattedElementsText = 'empty page';
    }

    let stepInfoDescription = '';
    if (context.stepInfo) {
      stepInfoDescription = `Current step: ${context.stepInfo.stepNumber + 1}/${context.stepInfo.maxSteps}`;
    }

    const timeStr = new Date().toISOString().slice(0, 16).replace('T', ' '); // Format: YYYY-MM-DD HH:mm
    stepInfoDescription += `Current date and time: ${timeStr}`;

    let actionResultsDescription = '';
    if (context.actionResults.length > 0) {
      for (let i = 0; i < context.actionResults.length; i++) {
        const result = context.actionResults[i];
        if (result.extractedContent) {
          actionResultsDescription += `\nAction result ${i + 1}/${context.actionResults.length}: ${result.extractedContent}`;
        }
        if (result.error) {
          // only use last line of error
          const error = result.error.split('\n').pop();
          actionResultsDescription += `\nAction error ${i + 1}/${context.actionResults.length}: ...${error}`;
        }
      }
    }

    // Sticky "found values" slot (M3): re-inject the lines the doc actions
    // returned into every step's state message, so document findings from an
    // early step never decay out of a weak model's attention. Content is
    // document-derived, hence wrapped as untrusted.
    let docFindingsDescription = '';
    if (context.docFindings.length > 0) {
      docFindingsDescription = `\n## FOUND IN THE DOCUMENT (kept from earlier search_doc/read_table results)\n${wrapUntrustedContent(context.docFindings.join('\n'))}\n`;
    }

    // Sticky PDF page slot (M4): the one page pinned by view_doc is re-sent
    // as an image with EVERY step's state message, right next to the doc
    // findings, so the Navigator keeps seeing the page while it works. An
    // empty slot costs one hint line; a stale slot (docs replaced since it
    // was set) degrades to that hint instead of showing a wrong page. The
    // image itself follows the same useVision gate as the page screenshot —
    // a non-vision model gets a text-only note.
    let stickyDocDescription = '';
    const stickyPage = getStickyPage(context.attachedDocs, context.pdfSticky);
    if (stickyPage) {
      const note = context.options.useVision
        ? 'The image of this page is attached below.'
        : '(this model has no vision — the image is omitted; read text with search_doc/read_table.)';
      stickyDocDescription = `\n## STICKY DOC PAGE ${stickyPage.page}/${stickyPage.pageCount} (${stickyPage.docName})\n${note}\n`;
    } else {
      const hint = formatStickyEmptyHint(context.attachedDocs);
      if (hint) stickyDocDescription = `\n${hint}\n`;
    }

    const currentTab = `{id: ${browserState.tabId}, url: ${browserState.url}, title: ${browserState.title}}`;
    const otherTabs = browserState.tabs
      .filter(tab => tab.id !== browserState.tabId)
      .map(tab => `- {id: ${tab.id}, url: ${tab.url}, title: ${tab.title}}`);
    const stateDescription = `
[Task history memory ends]
[Current state starts here]
The following is one-time information - if you need to remember it write it to memory:
Current tab: ${currentTab}
Other available tabs:
  ${otherTabs.join('\n')}
Interactive elements from top layer of the current page inside the viewport:
${formattedElementsText}
${stepInfoDescription}
${actionResultsDescription}
${docFindingsDescription}${stickyDocDescription}`;

    // Image parts, in the order the text announces them: the sticky doc page
    // (when pinned), then the page screenshot. Both are vision-gated.
    const imageParts: { type: 'image_url'; image_url: { url: string } }[] = [];
    if (stickyPage && context.options.useVision) {
      imageParts.push({ type: 'image_url', image_url: { url: stickyPage.image } });
    }
    if (browserState.screenshot && context.options.useVision) {
      imageParts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${browserState.screenshot}` } });
    }
    if (imageParts.length > 0) {
      return new HumanMessage({
        content: [{ type: 'text', text: stateDescription }, ...imageParts],
      });
    }

    return new HumanMessage(stateDescription);
  }
}

export { BasePrompt };
