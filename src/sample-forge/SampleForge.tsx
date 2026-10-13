import { useEffect, useRef, useState } from 'react'
import { Knob } from '../components/Knob'
import { DEFAULT_KICK_PATCH, KICK_PARAMETER_RANGES, kickPatchFingerprint, type KickNumericParameter } from './kickPatch'
import { KickWaveform } from './KickWaveform'
import type { ForgeSample } from './model'
import type { SampleForgeController } from './useSampleForge'
import './sample-forge.css'

const parameterLabels: Record<KickNumericParameter, { label: string; name: string; hint: string; percent?: boolean; precision?: number }> = {
  startFrequency: { label: 'START', name: 'Start Frequency', hint: 'Начальная частота тела Kick. Однократная огибающая опускает её к End Frequency.', precision: 1 },
  endFrequency: { label: 'END', name: 'End Frequency', hint: 'Конечная частота низкочастотного тела Kick.', precision: 1 },
  pitchDecay: { label: 'PITCH DEC', name: 'Pitch Decay', hint: 'Время снижения частоты от Start к End.', precision: 1 },
  pitchCurve: { label: 'CURVE', name: 'Pitch Curve', hint: 'Форма однократного спада частоты. Меняет характер удара.', precision: 2 },
  attack: { label: 'ATTACK', name: 'Attack', hint: 'Музыкальная атака тела. Короткая техническая защита границ действует отдельно.', precision: 1 },
  bodyDecay: { label: 'BODY DEC', name: 'Body Decay', hint: 'Время затухания низкочастотного тела. Kick завершается самостоятельно.', precision: 1 },
  clickAmount: { label: 'CLICK', name: 'Click Amount', hint: 'Доля короткого шумового транзиента. Он синтезируется из сохранённого Seed.', percent: true },
  clickDecay: { label: 'CLICK DEC', name: 'Click Decay', hint: 'Время затухания шумовой атаки.', precision: 1 },
  drive: { label: 'DRIVE', name: 'Drive', hint: 'Умеренная сатурация добавляет гармоники и плотность.', percent: true },
  tone: { label: 'TONE', name: 'Tone / Cutoff', hint: 'Частота низкочастотного фильтра, управляющая яркостью удара.', precision: 0 },
  outputLevel: { label: 'OUTPUT', name: 'Output Level', hint: 'Реальный уровень экспортируемого PCM. Тихие патчи автоматически не усиливаются.', percent: true },
}
const parameterOrder: KickNumericParameter[] = ['startFrequency', 'endFrequency', 'pitchDecay', 'pitchCurve', 'attack', 'bodyDecay', 'clickAmount', 'clickDecay', 'drive', 'tone', 'outputLevel']
const characterLabels = { base: 'BASE', sub: 'SUB', punch: 'PUNCH', tight: 'TIGHT', warm: 'WARM', custom: 'CUSTOM' }
const suggestedTags = ['Kick', 'Sub', 'Punchy', 'Tight', 'Warm', 'Soft', 'Hard', 'Deep', 'Distorted', 'Clean', 'Short', 'Long']
const db = (value: number | undefined) => value === undefined ? '—' : value <= -120 ? '−∞' : value.toFixed(1)
const durationText = (seconds: number | undefined) => seconds === undefined ? '—' : `${Math.round(seconds * 1000)} ms`
const dateText = (time: number) => new Date(time).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })

function SamplePad({ sample, selected, checked, playing, onSelect, onPlay, onCheck, onFavorite }: {
  sample: ForgeSample; selected: boolean; checked: boolean; playing: boolean
  onSelect: () => void; onPlay: () => void; onCheck: () => void; onFavorite: () => void
}) {
  return <article className={`forge-sample-pad${selected ? ' is-selected' : ''}${playing ? ' is-playing' : ''}`} data-sample-id={sample.id} data-character={sample.character} data-favorite={sample.favorite}>
    <div className="forge-pad-options"><label title="Добавить в ZIP"><input type="checkbox" aria-label={`Экспорт ${sample.name}`} checked={checked} onChange={onCheck} /><span className="sr-only">Добавить в экспорт</span></label><span>{characterLabels[sample.character]}</span><button type="button" className="forge-favorite" aria-label={`Избранное: ${sample.name}`} aria-pressed={sample.favorite} onClick={onFavorite}>{sample.favorite ? '★' : '☆'}</button></div>
    <button type="button" className="forge-pad-select" aria-label={`Выбрать ${sample.name}`} aria-pressed={selected} onClick={onSelect}>
      <strong title={sample.name}>{sample.name}</strong><KickWaveform render={sample.render} compact label={`PCM ${sample.name}`} />
    </button>
    <div className="forge-pad-footer"><span>{durationText(sample.render.metrics.duration)}</span><button type="button" aria-label={`Play ${sample.name}`} onClick={onPlay}>{playing ? '↻' : '▶'} Play</button></div>
    <p className="forge-pad-tags" title={sample.tags.join(', ')}>{sample.tags.slice(0, 3).join(' · ') || 'Без тегов'}{sample.tags.length > 3 ? ` +${sample.tags.length - 3}` : ''}</p>
  </article>
}

export function SampleForge({ controller: c }: { controller: SampleForgeController }) {
  const importInput = useRef<HTMLInputElement>(null)
  const [tagText, setTagText] = useState('')
  const [seedText, setSeedText] = useState(String(c.seed))
  const [nameText, setNameText] = useState(c.selected?.name ?? '')
  const [bankNameText, setBankNameText] = useState(c.bank?.name ?? '')
  const [libraryOpen, setLibraryOpen] = useState(false)
  useEffect(() => { setTagText('') }, [c.selectedId])
  useEffect(() => { setSeedText(String(c.seed)) }, [c.seed])
  useEffect(() => { setNameText(c.selected?.name ?? '') }, [c.selectedId, c.selected?.name])
  useEffect(() => { setBankNameText(c.bank?.name ?? '') }, [c.bank?.id, c.bank?.name])
  const selected = c.selected
  const render = c.preview
  const stale = !render || render.fingerprint !== kickPatchFingerprint(c.draftPatch)
  const working = c.busyKind !== null
  const filtering = c.filter.trim().toLocaleLowerCase()
  const matches = (sample: ForgeSample) => (!c.favoritesOnly || sample.favorite) && (!filtering || `${sample.name} ${sample.tags.join(' ')} ${sample.character}`.toLocaleLowerCase().includes(filtering))
  const samples = c.bank?.samples.filter(matches) ?? []
  const copies = c.bank?.copies.filter(matches) ?? []
  const totalSamples = c.bank ? c.bank.samples.length + c.bank.copies.length : 0
  const currentIsSaved = c.banks.some(bank => bank.id === c.bank?.id)
  const addTag = (value: string) => {
    const tag = value.trim().replace(/\s+/gu, ' ').normalize('NFC')
    if (!selected || !tag || selected.tags.length >= 24) return
    if (!selected.tags.some(current => current.toLocaleLowerCase('en-US') === tag.toLocaleLowerCase('en-US'))) c.setSampleTags([...selected.tags, tag])
    setTagText('')
  }
  const commitSeed = () => {
    const value = Number(seedText)
    if (seedText.trim() && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) c.setSeed(value)
    else setSeedText(String(c.seed))
  }
  const playSample = (id: string) => { if (c.select(id)) void c.playSelected() }
  const pad = (sample: ForgeSample) => <SamplePad key={sample.id} sample={sample} selected={c.selectedId === sample.id}
    checked={c.exportIds.includes(sample.id)} playing={c.previewPlaying && c.abSource === 'selected' && c.selectedId === sample.id}
    onSelect={() => c.select(sample.id)} onPlay={() => playSample(sample.id)} onCheck={() => c.toggleExportId(sample.id)}
    onFavorite={() => { if (c.select(sample.id)) c.toggleFavorite() }} />
  return <section className="sample-forge" aria-label="Sample Forge" data-render-status={c.renderStatus} data-dirty={c.dirty} data-bank-dirty={c.bankDirty}>
    <header className="forge-topbar">
      <div className="forge-title"><span className="eyebrow">CREATE → VARIATE → LISTEN → REFINE</span><h2>SAMPLE <strong>FORGE</strong></h2></div>
      <dl className="forge-spec"><div><dt>INSTRUMENT</dt><dd>Kick</dd></div><div><dt>VARIATIONS</dt><dd>16</dd></div><div><dt>INTENSITY</dt><dd>Medium</dd></div></dl>
      <label className="forge-seed">GENERATION SEED<input type="number" aria-label="Generation Seed" min="0" max="4294967295" step="1" value={seedText} onChange={event => { setSeedText(event.target.value); const next = event.target.valueAsNumber; if (Number.isInteger(next) && next >= 0 && next <= 0xffffffff) c.setSeed(next) }} onBlur={commitSeed} onKeyDown={event => { if (event.key === 'Enter') { commitSeed(); event.currentTarget.blur() } }} /></label>
      <div className="forge-batch-actions"><button type="button" className="forge-primary" onClick={() => void c.generateBatch()} disabled={working}>GENERATE 16 VARIATIONS</button><button type="button" onClick={() => void c.regenerateBatch()} disabled={working || !c.bank}>Regenerate Batch</button></div>
      <div className="forge-bank-actions"><button type="button" onClick={() => void c.saveBank()} disabled={!c.bank || working}>Save Bank{c.bankDirty ? ' ●' : ''}</button><button type="button" className="forge-export" onClick={() => void c.exportZIP()} disabled={!c.bank || working || !c.exportIds.length}>Export ZIP · {c.exportIds.length}</button></div>
    </header>
    <div className="forge-status-row">
      <p className={`forge-notice${c.bankDirty ? ' has-unsaved' : ''}`} role="status">{c.notice || 'Все звуки синтезируются локально. Base Patch — отдельный эталон.'}</p>
      {c.busyKind && <div className="forge-progress"><span>{c.busyKind === 'generation' ? 'Генерация' : c.busyKind === 'export' ? 'Экспорт ZIP' : c.busyKind === 'import' ? 'Импорт Patch' : 'Сохранение'} · {Math.round(c.progress * 100)}%</span><progress aria-label="Прогресс Sample Forge" value={c.progress} max="1" />{(c.busyKind === 'generation' || c.busyKind === 'export') && <button type="button" onClick={c.cancelOperation}>Cancel {c.busyKind === 'generation' ? 'Generation' : 'Export'}</button>}</div>}
    </div>
    {c.error && <p className="forge-error" role="alert">{c.error}</p>}
    <div className="forge-workbench">
      <section className="forge-panel forge-editor" aria-label="Kick Editor">
        <div className="forge-panel-heading"><h2>KICK EDITOR</h2><button type="button" className="forge-base-select" aria-label="Выбрать Base Patch" aria-pressed={c.selectedId === 'base'} onClick={() => c.select('base')}>Base Patch</button></div>
        <div className="forge-editor-caption"><strong title={selected?.name}>{selected?.name ?? 'Base Kick'}</strong><span className={c.dirty ? 'is-dirty' : ''}>{c.dirty ? 'MODIFIED' : c.selectedId === 'base' ? 'REFERENCE' : 'SAVED PATCH'}</span></div>
        <div className="forge-knobs">{parameterOrder.map(key => {
          const meta = parameterLabels[key], range = KICK_PARAMETER_RANGES[key], factor = meta.percent ? 100 : 1
          return <Knob key={key} name={`Kick ${meta.name}`} label={meta.label} hint={meta.hint} value={c.draftPatch[key] * factor}
            min={range.min * factor} max={range.max * factor} step={range.step * factor} defaultValue={DEFAULT_KICK_PATCH[key] * factor}
            unit={meta.percent ? '%' : range.unit || '×'} precision={meta.precision ?? 0} logarithmic={range.logarithmic}
            onChange={value => c.editPatch(key, value / factor)} />
        })}<label className="forge-noise-control"><span>NOISE COLOR</span><select aria-label="Kick Noise Color" value={c.draftPatch.noiseColor} onChange={event => c.editPatch('noiseColor', event.target.value as 'white' | 'pink' | 'brown')}><option value="white">White</option><option value="pink">Pink</option><option value="brown">Brown</option></select><small>Шумовая атака</small></label></div>
        <div className="forge-editor-actions"><button type="button" onClick={c.undo} disabled={!c.canUndo}>Undo</button><button type="button" onClick={c.resetGenerated}>Reset to Generated</button><button type="button" onClick={() => void c.renderNow()} disabled={c.renderStatus === 'rendering'}>Re-render</button><button type="button" className="forge-primary" onClick={() => void c.saveChanges()} disabled={!selected || working || c.renderStatus === 'rendering'}>Save Changes</button></div>
        <div className="forge-patch-actions"><button type="button" onClick={() => void c.duplicatePatch()} disabled={!selected || working}>Duplicate Patch</button><button type="button" onClick={c.exportPatch}>Export Patch JSON</button><button type="button" onClick={() => importInput.current?.click()}>Import Patch JSON</button><input ref={importInput} className="sr-only" aria-label="Файл Kick Patch JSON" type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; if (file) void c.importPatch(file); event.currentTarget.value = '' }} /></div>
      </section>
      <section className="forge-panel forge-preview" aria-label="Waveform Preview">
        <div className="forge-panel-heading"><h2>WAVEFORM · REAL PCM</h2><span className={`forge-render-badge${stale ? ' is-stale' : ''}`}>{c.renderStatus === 'rendering' ? 'RENDERING…' : stale ? 'WAV PENDING' : c.dirty ? 'PREVIEW UPDATED · SAVE PATCH' : 'PATCH + WAV SYNCED'}</span></div>
        <KickWaveform render={render} label={`Реальный PCM: ${selected?.name ?? 'Base Kick'}`} />
        <div className="forge-wave-legend"><span><i />PCM min / max</span><span><i />RMS-огибающая · 20 ms</span><span>Фиксированный масштаб ±1</span></div>
        <dl className="forge-metrics"><div><dt>DURATION</dt><dd>{durationText(render?.metrics.duration)}</dd></div><div><dt>PEAK</dt><dd>{db(render?.metrics.peakDbfs)} <small>dBFS</small></dd></div><div><dt>RMS</dt><dd>{db(render?.metrics.rmsDbfs)} <small>dBFS</small></dd></div><div><dt>FORMAT</dt><dd>48k <small>Mono · 24-bit</small></dd></div></dl>
        <div className="forge-preview-controls" role="group" aria-label="Предпрослушивание Kick"><button type="button" aria-pressed={c.previewPlaying && c.abSource === 'base'} onClick={() => void c.playBase()}>▶ Base Kick · A</button><button type="button" className="forge-primary" aria-pressed={c.previewPlaying && c.abSource === 'selected'} onClick={() => void c.playSelected()}>▶ Selected Kick · B</button><button type="button" onClick={c.stopPreview}>■ Stop Preview</button><button type="button" onClick={() => void c.replay()}>↻ Replay</button><button type="button" className="forge-compare" onClick={() => void c.toggleAB()} aria-label="A/B Compare">A/B Compare <b>{c.abSource === 'base' ? 'A' : 'B'}</b></button><button type="button" onClick={() => void c.playNext()} disabled={!c.bank}>Next ▶</button></div>
        <div className="forge-preview-footer"><label><input type="checkbox" aria-label="Прослушивать изменения Kick" checked={c.autoPreview} onChange={event => c.setAutoPreview(event.target.checked)} />Слышать изменения после настройки</label><span>Preview {db(20 * Math.log10(c.previewLevel))} dB · без нормализации</span></div>
        <p className="forge-headroom">{render && render.metrics.attenuationDb < -0.001 ? `Защита пика ослабила PCM на ${Math.abs(render.metrics.attenuationDb).toFixed(1)} dB. ` : 'Защита пика: максимум −1 dBFS. '}Тихие варианты не усиливаются. RMS — средний уровень, не LUFS.</p>
      </section>
      <section className="forge-panel forge-metadata" aria-label="Метаданные Kick">
        <div className="forge-panel-heading"><h2>SELECTED KICK</h2><button type="button" className="forge-favorite" aria-label="Избранное выбранного Kick" aria-pressed={selected?.favorite ?? false} disabled={!selected} onClick={c.toggleFavorite}>{selected?.favorite ? '★' : '☆'}</button></div>
        <label>Название<input type="text" aria-label="Название Kick" maxLength={120} value={nameText} disabled={!selected} onChange={event => setNameText(event.target.value)} onBlur={() => { if (nameText.trim()) c.setSampleName(nameText); else setNameText(selected?.name ?? '') }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
        <div className="forge-tag-heading"><span>Теги</span><small>{selected?.tags.length ?? 0} / 24</small></div>
        <div className="forge-tags">{selected?.tags.map(tag => <button type="button" key={tag} aria-label={`Удалить тег ${tag}`} onClick={() => c.setSampleTags(selected.tags.filter(value => value !== tag))}>{tag}<span>×</span></button>)}{!selected?.tags.length && <span className="forge-empty-tags">Добавьте характер звука</span>}</div>
        <form className="forge-tag-form" onSubmit={event => { event.preventDefault(); addTag(tagText) }}><input aria-label="Новый тег Kick" type="text" maxLength={48} value={tagText} disabled={!selected} list="forge-suggested-tags" placeholder="Punchy, Hard…" onChange={event => setTagText(event.target.value)} /><datalist id="forge-suggested-tags">{suggestedTags.map(tag => <option key={tag} value={tag} />)}</datalist><button type="submit" disabled={!selected || !tagText.trim() || selected.tags.length >= 24}>＋</button></form>
        <div className="forge-quick-tags">{['Punchy', 'Hard', 'Short'].filter(tag => !selected?.tags.some(value => value.toLowerCase() === tag.toLowerCase())).map(tag => <button type="button" key={tag} onClick={() => addTag(tag)} disabled={!selected || selected.tags.length >= 24}>＋{tag}</button>)}</div>
        <dl className="forge-patch-info"><div><dt>CHARACTER</dt><dd>{selected ? characterLabels[selected.character] : 'BASE'}</dd></div><div><dt>NOISE SEED</dt><dd>{c.draftPatch.seed}</dd></div><div><dt>GENERATOR</dt><dd>{c.bank?.generatorVersion ?? '1.0.0'} · Medium</dd></div><div><dt>DC OFFSET</dt><dd>{render ? render.metrics.dcOffset.toExponential(2) : '—'}</dd></div></dl>
        <p className="forge-metadata-note">Патч и готовый WAV сохраняются вместе. Теги и избранное входят в банк. <strong>{c.bankDirty ? 'Банк изменён — нажмите Save Bank.' : 'Данные хранятся локально.'}</strong></p>
      </section>
    </div>
    <section className="forge-panel forge-grid-panel" aria-label="Kick Variations">
      <div className="forge-grid-toolbar"><div><h2>16 KICK VARIATIONS</h2><span>{c.bank ? `${samples.length} из 16 · Base отдельно` : 'Создайте первый банк из Base Patch'}</span></div><label className="forge-filter"><span className="sr-only">Поиск Kick по названию и тегам</span><input type="search" aria-label="Поиск Kick по названию и тегам" value={c.filter} onChange={event => c.setFilter(event.target.value)} placeholder="Название или тег…" /></label><label className="forge-favorites-filter"><input type="checkbox" checked={c.favoritesOnly} onChange={event => c.setFavoritesOnly(event.target.checked)} />★ Избранное</label><button type="button" onClick={c.selectAllForExport} disabled={!c.bank}>Выбрать все для ZIP</button><span className="forge-export-count">ZIP: {c.exportIds.length} / {totalSamples}</span></div>
      {c.bank ? <><div className="forge-sample-grid">{samples.map(pad)}</div>{!samples.length && <p className="forge-empty">Нет вариантов по этому фильтру. Измените поиск или выключите «Избранное».</p>}{c.bank.copies.length > 0 && <details className="forge-copies"><summary>Мои копии · {c.bank.copies.length}</summary><div className="forge-sample-grid">{copies.map(pad)}</div></details>}</> : <div className="forge-start"><span>01 / 16</span><strong>Сначала создайте свой Kick.</strong><p>Настройте Base Patch, послушайте его и нажмите Generate. Получите по четыре варианта Sub, Punch, Tight и Warm.</p><button type="button" className="forge-primary" onClick={() => void c.generateBatch()} disabled={working}>Generate 16 Variations</button></div>}
    </section>
    <section className="forge-panel forge-library" aria-label="Sample Library">
      <div className="forge-library-heading"><h2>MY SAMPLE BANKS <span>{c.banks.length}</span></h2><label className="forge-bank-name"><span>Банк</span><input type="text" aria-label="Название Sample Bank" maxLength={120} value={bankNameText} disabled={!c.bank} placeholder="SOUND LAB KICK PACK" onChange={event => setBankNameText(event.target.value)} onBlur={() => { if (bankNameText.trim()) c.setBankName(bankNameText); else setBankNameText(c.bank?.name ?? '') }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label><label className="forge-bank-selector"><span className="sr-only">Открыть Sample Bank</span><select aria-label="Открыть Sample Bank" value={currentIsSaved ? c.bank?.id ?? '' : ''} onChange={event => { if (event.target.value) void c.loadBank(event.target.value) }} disabled={working}><option value="">{c.bank ? 'Текущий новый банк' : 'Сохранённые банки…'}</option>{c.banks.map(bank => <option key={bank.id} value={bank.id}>{bank.name} · {dateText(bank.createdAt)}</option>)}</select></label><button type="button" aria-expanded={libraryOpen} onClick={() => setLibraryOpen(value => !value)}>Библиотека {libraryOpen ? '⌃' : '⌄'}</button></div>
      {libraryOpen && <div className="forge-bank-list">{c.banks.length ? c.banks.map(bank => <article key={bank.id}><div><strong>{bank.name}</strong><small>{dateText(bank.createdAt)} · {bank.sampleCount} Kick{bank.copyCount ? ` + ${bank.copyCount} копий` : ''} · Seed {bank.batchSeed}</small></div><button type="button" onClick={() => void c.loadBank(bank.id)} disabled={working}>Открыть</button><button type="button" className="forge-delete" onClick={() => void c.deleteBank(bank.id)} disabled={working}>Удалить</button></article>) : <p className="forge-empty">Сохранённых банков пока нет. Save Bank сохраняет весь набор в IndexedDB.</p>}</div>}
      <p className="forge-storage-note">Локальная библиотека Sample Forge отделена от My Phrases и MIDI Learn. ZIP содержит WAV, редактируемые Patch JSON, manifest и README. Сэмплы не отправляются на сервер.</p>
    </section>
  </section>
}
