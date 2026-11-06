import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-llm-free-mode/types'
import type { FailoverChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Free-mode route change or failover stop. */
    'model-failover': FailoverChatData
  }
}

/**
 * Tell whether an event replays its step on another route, which discards the failed attempt.
 * @param event - Conversation event.
 * @returns true for an `llm/failover` record that names a next route.
 */
export function isRouteChange(event: ConversationMatch['event']): boolean {
  return event.type === 'llm/failover' && event.data.to !== undefined
}

/** One row per durable `llm/failover` record. */
export const failoverDefinition: ConversationNodeDefinition<FailoverChatData> = {
  kind: 'model-failover',
  target: 'chat',
  match: event => event.type === 'llm/failover' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'llm/failover') throw new Error('model-failover start requires llm/failover')
    return { ...match.event.data, seq: match.event.seq, time: match.event.time }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : chatNode(context, 'model-failover', context.state.seq, context.state),
}

/**
 * Register the free-mode failover business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerFailoverConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(failoverDefinition)
}
