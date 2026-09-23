/* eslint-disable @typescript-eslint/no-unused-vars */
import { BasePrompt } from './base';
import { type HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { createLogger } from '@src/background/log';
import { buildNavigatorSystemPrompt } from './templates/navigator';

const logger = createLogger('agent/prompts/navigator');

export class NavigatorPrompt extends BasePrompt {
  private systemMessage: SystemMessage;

  constructor(
    private readonly maxActionsPerStep = 10,
    // Submit guard (Wave 3): when true (product default) the prompt gains the
    // "ask_user before irreversible actions" rule block.
    private readonly askBeforeIrreversible = true,
  ) {
    super();

    // Format the template with maxActionsPerStep and the irreversible-action rule
    this.systemMessage = new SystemMessage(
      buildNavigatorSystemPrompt(this.maxActionsPerStep, this.askBeforeIrreversible),
    );
  }

  getSystemMessage(): SystemMessage {
    /**
     * Get the system prompt for the agent.
     *
     * @returns SystemMessage containing the formatted system prompt
     */
    return this.systemMessage;
  }

  async getUserMessage(context: AgentContext): Promise<HumanMessage> {
    return await this.buildBrowserStateUserMessage(context);
  }
}
