/** The communication mirror: the switch, the document it opens, and the entries it appends. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Mirror, entryMarkdown, localTime } from '../src/app/mirror.ts'
import { Store } from '../src/app/store.ts'
import type { Trigger } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'

const at = new Date('2026-11-19T12:30:00.000Z')
interface Harness { directory: string; store: Store; effects: Effects; mirror: Mirror; calls: string[]; contents: string[]; created: number }
const started: Harness[] = []

/** A mirror over a temporary store whose `lark-cli` records each call and the markdown it was given; `fail` makes an append fail. */
function start(options: { fail?: boolean } = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-'))
  const store = new Store(join(directory, 'db.sqlite'))
  const effects = new Effects(store, new HealthBoard())
  const calls: string[] = []
  const contents: string[] = []
  let created = 0
  const lark = async <T>(args: string[]): Promise<T> => {
    calls.push(args.join(' '))
    const content = args.indexOf('--content')
    if (content >= 0) contents.push(readFileSync(args[content + 1]!.slice(1), 'utf8'))
    if (args[0] === 'docs' && args[1] === '+create') {
      created += 1
      return { document: { document_id: `doc-${created}`, url: `https://feishu.example/${created}` } } as T
    }
    if (options.fail && args[0] === 'docs' && args[1] === '+update') throw new Error('transient')
    return {} as T
  }
  const mirror = new Mirror({ store, effects, commands: { lark } as unknown as Pick<Commands, 'lark'>,
    settings: () => store.settings(), now: () => at })
  mirror.install()
  effects.start()
  const harness = { directory, store, effects, mirror, calls, contents, get created() { return created } }
  started.push(harness)
  return harness
}
afterEach(() => {
  for (const harness of started.splice(0)) { harness.store.close(); rmSync(harness.directory, { recursive: true, force: true }) }
})

const trigger = (text: string, human = true): Trigger => ({ id: 'trig-1', source: 'feishu',
  threads: [{ source: 'feishu', id: 'oc_1' }], actor: { source: 'feishu', id: 'ou_reader' }, human, at: at.toISOString(), text, meta: {} })
const outgoing = (id: string, text: string) => ({ id, channel: { source: 'feishu', thread: 'feishu:oc_1', address: {} },
  text, kind: 'reply' as const })
/** The markdown a call passed through `--content @file`. */
const content = (harness: Harness): string => harness.contents.at(-1) ?? ''
const configure = (harness: Harness, mirror: { enabled: boolean; folder?: string; share?: string[] }) => {
  const before = harness.store.settings()
  harness.store.saveSettings({ ...before, mirror: { enabled: mirror.enabled, folder: mirror.folder ?? '', share: mirror.share ?? [] } })
  harness.mirror.changed(before, harness.store.settings())
}

it('writes one entry as a heading naming who and where, then the message quoted', () => {
  const markdown = entryMarkdown({ at: at.toISOString(), who: 'person', source: 'feishu', text: '第一行\n第二行' })
  expect(markdown).toBe(`### ${localTime(at)} · You · feishu\n\n> 第一行\n> 第二行\n\n`)
  expect(entryMarkdown({ at: at.toISOString(), who: 'agent', source: 'github', text: 'x'.repeat(12_001) }))
    .toMatch(/^### .+ · Superagent · github\n\n> x+\u2026/)
})

it('mirrors nothing while the switch is off', async () => {
  const harness = start()
  harness.mirror.incoming(trigger('hello'))
  harness.mirror.outgoing(outgoing('m1', 'hi'))
  await harness.effects.idle()
  expect(harness.calls).toEqual([])
})

it('opens a document when the switch is turned on, and appends every message to it', async () => {
  const harness = start()
  harness.store.saveSettings(SettingsSchema.parse({ ...harness.store.settings(),
    policy: { rules: [], sources: { feishu: { allowed: [{ id: 'ou_reader' }] } } } }))
  configure(harness, { enabled: true })
  await harness.effects.idle()
  expect(harness.calls.map(call => call.split(' ').slice(0, 2).join(' '))).toEqual(['docs +create', 'drive +member-add'])
  expect(harness.calls[0]).toContain(`Superagent conversation · ${localTime(at)}`)
  // The document is granted to the senders the Feishu Policy allows, so the person who talks to the agent can read it.
  expect(harness.calls[1]).toContain('--member-id ou_reader --perm view')
  expect(harness.store.get(KV.mirror.doc)).toEqual({ token: 'doc-1', url: 'https://feishu.example/1', at: at.toISOString(), granted: true })

  harness.mirror.incoming(trigger('请把这条记下来'))
  await harness.effects.idle()
  const append = harness.calls.at(-1)!
  expect(append.startsWith('docs +update --doc doc-1 --command append')).toBe(true)
  expect(content(harness)).toContain('请把这条记下来')
  expect(content(harness)).toContain('· You · feishu')

  harness.mirror.outgoing(outgoing('m1', '已记下。'))
  await harness.effects.idle()
  expect(content(harness)).toContain('· Superagent · feishu')
})

it('skips a person\'s message the Source marked as a bot\'s', async () => {
  const harness = start()
  configure(harness, { enabled: true })
  await harness.effects.idle()
  const count = harness.calls.length
  harness.mirror.incoming(trigger('CI says hello', false))
  await harness.effects.idle()
  expect(harness.calls.length).toBe(count)
})

it('does not append the same message twice, even when its effect is queued again', async () => {
  const harness = start()
  configure(harness, { enabled: true })
  await harness.effects.idle()
  const count = harness.calls.length
  harness.mirror.incoming(trigger('只说一次'))
  await harness.effects.idle()
  expect(harness.calls.length).toBe(count + 1)
  harness.mirror.incoming(trigger('只说一次'))
  await harness.effects.idle()
  expect(harness.calls.length).toBe(count + 1)
})

it('opens a new document each time it is turned on again, and stops appending once it is off', async () => {
  const harness = start()
  configure(harness, { enabled: true })
  await harness.effects.idle()
  harness.mirror.incoming(trigger('first'))
  await harness.effects.idle()
  configure(harness, { enabled: false })
  const count = harness.calls.length
  harness.mirror.incoming(trigger('second'))
  await harness.effects.idle()
  expect(harness.calls.length).toBe(count)
  configure(harness, { enabled: true })
  await harness.effects.idle()
  expect(harness.created).toBe(2)
  expect(harness.store.get(KV.mirror.doc)?.token).toBe('doc-2')
})

it('does not open another document when the folder did not change', async () => {
  const harness = start()
  configure(harness, { enabled: true })
  await harness.effects.idle()
  configure(harness, { enabled: true, folder: '' })
  await harness.effects.idle()
  expect(harness.created).toBe(1)
})

it('creates the document in the configured folder', async () => {
  const harness = start()
  configure(harness, { enabled: true, folder: 'fld-1' })
  await harness.effects.idle()
  expect(harness.calls[0]).toContain('--parent-token fld-1')
})

it('re-grants the open document when only the recipients change', async () => {
  const harness = start()
  configure(harness, { enabled: true })
  await harness.effects.idle()
  const count = harness.calls.length
  configure(harness, { enabled: true, share: ['ou_reader', 'ou_other'] })
  await harness.effects.idle()
  expect(harness.created).toBe(1)
  expect(harness.calls.slice(count)).toEqual(['drive +member-add --token doc-1 --type docx --member-type openid --member-id ou_reader --perm view --yes',
    'drive +member-add --token doc-1 --type docx --member-type openid --member-id ou_other --perm view --yes'])
})

it('keeps a failed append queued so a later pass can retry it', async () => {
  const harness = start({ fail: true })
  configure(harness, { enabled: true })
  await harness.effects.idle()
  harness.mirror.incoming(trigger('重试我'))
  await vi.waitFor(() => expect(harness.effects.pending('mirror')).toBe(true))
})
