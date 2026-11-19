/** Communication settings group: the switch that mirrors people's messages and the agent's messages into a Feishu document. */
import { useState } from 'react'
import type { SettingsView } from './api.ts'
import { DisclosureRow, Icon, Input } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { ConfigHistory, Field, Fields, SwitchRow, useBlockDraft, useSettings } from './settings-kit.tsx'
import { healthText, when } from './text.ts'
import { ExternalLink, Hint, LabelValue } from './widgets.tsx'

type Mirror = SettingsView['mirror']
type Value = Mirror['value']

/** Ids pasted with commas, spaces, semicolons or line breaks; empty entries dropped. */
const split = (text: string): string[] => text.split(/[\s,;]+/).map(part => part.trim()).filter(Boolean)

function Document({ mirror }: { mirror: Mirror }) {
  const { t } = usePanel()
  if (!mirror.doc) return null
  return <div className="dt-row-meta">
    <LabelValue label={t('mirrorDocument')} value={<ExternalLink href={mirror.doc.url}>{t('mirrorOpen')}</ExternalLink>} />
    <LabelValue label={t('mirrorOpenedAt')} value={when(mirror.doc.at, t('lang'))} />
  </div>
}

/** The switch, the document it appends to, and the folder and recipients a new document uses. */
export function CommunicationSettings() {
  const { t } = usePanel()
  const { mirror } = useSettings().settings
  const draft = useBlockDraft('mirror', mirror.value, mirror.revision)
  const value = draft.value
  const [advanced, setAdvanced] = useState(false)
  const [share, setShare] = useState(mirror.value.share.join(', '))
  const edit = (next: Partial<Value>) => draft.edit({ ...value, ...next })
  return <div className="dt-form">
    <form className="dt-card" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <SwitchRow label={t('mirrorEnabled')} hint={t('mirrorEnabledHint')} checked={value.enabled}
          onChange={enabled => edit({ enabled })} />
        <Hint>{t('mirrorIntro')}</Hint>
        <Document mirror={mirror} />
        {value.enabled && !mirror.doc && <Hint>{t('mirrorNone')}</Hint>}
        {mirror.health?.state === 'error' && <p className="dt-error" role="alert">{healthText(t, mirror.health)}</p>}
        <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advanced}
          onToggle={() => setAdvanced(!advanced)}>
          <div className="dt-disclosure-body">
            <Field label={t('mirrorFolder')} hint={t('mirrorFolderHint')}>
              <Input value={value.folder} maxLength={200} placeholder={t('unsetValue')}
                onChange={event => edit({ folder: event.target.value })} />
            </Field>
            <Field label={t('mirrorShare')} hint={t('mirrorShareHint')}>
              <Input value={share} onChange={event => { setShare(event.target.value); edit({ share: split(event.target.value) }) }} />
            </Field>
          </div>
        </DisclosureRow>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['mirror']} />
  </div>
}
