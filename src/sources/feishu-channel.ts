/** Feishu outbound channel: posts threaded bot replies and constructs chat deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/**
 * Builds the `lark-cli` arguments for one reply.
 * - A direct conversation has no topic stream, and Feishu answers `reply_in_thread` there with its generic internal
 *   error (2200), so the flag is sent only to group chats (recorded as `direct: 'true'` on the address).
 * - `lark-cli` reads a flag value that starts with `@` as a file reference, so a reply opening with a mention goes
 *   through `--content` as a text message instead of `--markdown`.
 */
export function feishuReplyArgs(messageId: string, text: string, direct: boolean, idempotencyKey: string): string[] {
  const body = text.startsWith('@') ? ['--content', JSON.stringify({ text })] : ['--markdown', text]
  const topic = direct ? [] : ['--reply-in-thread']
  return ['im', '+messages-reply', '--message-id', messageId, ...body, ...topic, '--idempotency-key', idempotencyKey]
}
/** Replies in the topic of the target message in a group chat, and as a plain reply in a direct one; Feishu keeps at most one reply per idempotency key (the outgoing message's `message.id`). */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const text = checkedImText(message.text)
  const reply = feishuReplyArgs(messageId, text, message.channel.address.direct === 'true', message.id)
  try { await host.commands.lark(reply) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
