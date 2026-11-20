/**
 * Communication mirror: with the switch on, people's messages and the agent's messages are appended to one Feishu
 * document, a new one each time it is turned on. Entries go through the effect queue, so they survive a restart and a
 * failed append retries without losing the conversation.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { OutboundMessage, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

/** One message as the document shows it: who wrote it, where, and when. */
export interface MirrorEntry {
  at: string
  who: 'person' | 'agent'
  /** Source kind the message came from, such as `feishu`. */
  source: string
  text: string
}
/** What a mirror effect does: open a new document, re-grant the current one, or append one entry. */
export type MirrorPayload = { form: 'open' } | { form: 'grants' } | ({ form: 'entry' } & MirrorEntry)
/** The Feishu document entries go to; `granted` records that its recipients were granted view access. */
export interface MirrorDocument { token: string; url: string; at: string; granted?: boolean }

/** Host dependencies of `Mirror`. */
export interface MirrorHost {
  readonly store: Pick<Store, 'get' | 'set' | 'delete'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly commands: Pick<Commands, 'lark'>
  /** The current settings, whose `mirror` block decides whether anything is appended. */
  readonly settings: () => Settings
  /** Clock used for entry times and document titles; tests replace it. */
  readonly now?: () => Date
}

const DOC_TITLE = 'Superagent conversation'
const DOC_INTRO = 'People\'s messages and the Superagent\'s messages are appended here while the switch is on.\n'
/** Longest message text one entry carries; a longer message is truncated with an ellipsis. */
const ENTRY_TEXT_MAX = 12_000
/** How many appended entry keys are remembered to keep a retried effect from appending twice. */
const REMEMBERED = 500
const CREATED = z.object({ document: z.object({ document_id: z.string().trim().min(1), url: z.string().trim().min(1) }) })

/** Local `YYYY-MM-DD HH:mm`; the document is read in local time, not the UTC the store uses. */
export function localTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
}
/** The markdown one entry appends: a heading naming who wrote it, then the message as a quote. */
export function entryMarkdown(entry: MirrorEntry): string {
  const who = entry.who === 'person' ? 'You' : 'Superagent'
  const text = entry.text.length > ENTRY_TEXT_MAX ? `${entry.text.slice(0, ENTRY_TEXT_MAX)}…` : entry.text
  const quoted = text.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`.trimEnd()).join('\n')
  return `### ${localTime(new Date(entry.at))} · ${who} · ${entry.source}\n\n${quoted}\n\n`
}

/**
 * Appends people's messages and the agent's messages to one Feishu document through the bot's `lark-cli`.
 * `Runtime` hands it the messages that arrive and the ones the Outbox sends; `Settings.save` tells it when the switch
 * changes. The document ID lives in the store, so a restart continues the same document.
 */
export class Mirror {
  constructor(private readonly host: MirrorHost) {}
  /** The document entries go to, if one was opened. */
  current(): MirrorDocument | undefined { return this.host.store.get(KV.mirror.doc) }
  /** Records the effect handler: appends one entry at a time, in order, retrying with backoff. */
  install(): void {
    this.host.effects.handle('mirror', (payload, key) => this.run(payload, key), { retry: [5_000, 300_000], ordered: true })
  }
  /** A person's message reached the domain: queue it for the document. */
  incoming(trigger: Trigger): void {
    if (!trigger.human) return
    this.push(trigger.id, { form: 'entry', at: trigger.at, who: 'person', source: trigger.source, text: trigger.text })
  }
  /** The agent sends a message to a person: queue it for the document. */
  outgoing(message: OutboundMessage): void {
    this.push(message.id, { form: 'entry', at: this.clock().toISOString(), who: 'agent', source: message.channel.source,
      text: message.text })
  }
  /**
   * Reacts to a saved settings change: turning the switch on opens a new document (a new one also when the folder
   * changes), and a changed recipient list applies to the document that is open.
   */
  changed(from: Settings, to: Settings): void {
    if (!to.mirror.enabled) return
    if (!from.mirror.enabled || from.mirror.folder !== to.mirror.folder) return this.reopen()
    if (from.mirror.share.join('\n') !== to.mirror.share.join('\n')) this.enqueue('grants', { form: 'grants' })
  }
  /** Opens the next document: the one an entry or a grant would otherwise use is abandoned, not edited. */
  private reopen(): void {
    this.host.store.delete(KV.mirror.doc)
    this.host.store.set(KV.mirror.entries, [])
    this.enqueue('open', { form: 'open' })
  }
  private push(id: string, payload: MirrorPayload): void {
    if (!this.host.settings().mirror.enabled) return
    this.enqueue(id, payload)
  }
  private enqueue(id: string, payload: MirrorPayload): void {
    // An entry keeps one effect per message; an opening or a grant keeps one per switch, by the time it was queued.
    const key = payload.form === 'entry' ? `entry:${id}` : `${payload.form}:${this.clock().getTime()}`
    this.host.effects.enqueue('mirror', key, payload)
  }
  private clock(): Date { return this.host.now?.() ?? new Date() }
  private async run(payload: MirrorPayload, key: string): Promise<void> {
    const { store, settings } = this.host
    if (!settings().mirror.enabled) return
    if (payload.form === 'entry' && this.appended(key)) return
    const doc = this.current() ?? await this.open()
    // Opening and granting share one step, so a grant that failed after the document was stored is retried.
    if (payload.form === 'open' || payload.form === 'grants') { await this.granted(doc); return }
    const target = doc.granted ? doc : await this.granted(doc)
    const file = this.file(entryMarkdown(payload))
    try {
      await this.host.commands.lark(['docs', '+update', '--doc', target.token, '--command', 'append', '--doc-format', 'markdown',
        '--content', `@${file}`])
    } finally { rmSync(dirname(file), { recursive: true, force: true }) }
    store.set(KV.mirror.entries, [...this.appendedKeys().slice(-(REMEMBERED - 1)), key])
  }
  /** Grants the document's recipients view access and records that they have it. */
  private async granted(doc: MirrorDocument): Promise<MirrorDocument> {
    await this.grant(doc, this.host.settings())
    const marked = { ...doc, granted: true }
    this.host.store.set(KV.mirror.doc, marked)
    return marked
  }
  /** True when an earlier attempt appended this entry's effect key and only its final bookkeeping failed. */
  private appended(key: string): boolean { return this.appendedKeys().includes(key) }
  private appendedKeys(): string[] { return this.host.store.get(KV.mirror.entries) ?? [] }
  /** Opens a document for the current settings and makes it the current one; the caller grants it, so a failed grant retries. */
  private async open(): Promise<MirrorDocument> {
    const settings = this.host.settings(), at = this.clock()
    const file = this.file(DOC_INTRO)
    let created: z.infer<typeof CREATED>
    try {
      created = CREATED.parse(await this.host.commands.lark(['docs', '+create', '--title', `${DOC_TITLE} · ${localTime(at)}`,
        '--doc-format', 'markdown', '--content', `@${file}`,
        ...settings.mirror.folder ? ['--parent-token', settings.mirror.folder] : []]))
    } finally { rmSync(dirname(file), { recursive: true, force: true }) }
    const doc = { token: created.document.document_id, url: created.document.url, at: at.toISOString() }
    this.host.store.set(KV.mirror.doc, doc)
    return doc
  }
  /** Grants view access to the configured recipients, or to the senders the Feishu Policy allows when none is named. */
  private async grant(doc: MirrorDocument, settings: Settings): Promise<void> {
    for (const id of this.recipients(settings)) await this.host.commands.lark(['drive', '+member-add', '--token', doc.token,
      '--type', 'docx', '--member-type', 'openid', '--member-id', id, '--perm', 'view', '--yes'])
  }
  private recipients(settings: Settings): string[] {
    if (settings.mirror.share.length) return settings.mirror.share
    return (settings.policy.sources.feishu?.allowed ?? []).map(entry => entry.id).filter(id => id.startsWith('ou_'))
  }
  /** Writes markdown to a private temporary file, which the bot's CLI reads as `@path`. */
  private file(content: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-mirror-'))
    const path = join(directory, 'entry.md')
    writeFileSync(path, content, 'utf8')
    return path
  }
}
