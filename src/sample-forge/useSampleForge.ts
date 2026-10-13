import { useEffect, useRef, useState, type RefObject } from 'react'
import type { SynthEngine } from '../audio/SynthEngine'
import { copyKickPatch, DEFAULT_KICK_PATCH, kickPatchFingerprint, normalizeKickPatch, type KickNumericParameter, type KickPatch } from './kickPatch'
import { renderKick, type RenderedKick } from './audio/KickRenderer'
import { SamplePreview } from './SamplePreview'
import { createForgeSample, generateSampleBank } from './VariationGenerator'
import { copyBank, GENERATOR_VERSION, samplesInBank, type ForgeSample, type PortableKickPatch, type SampleBank } from './model'
import { deleteSampleBank, listSampleBanks, loadSampleBank, loadWorkingBase, normalizeTags, saveSampleBank, saveWorkingBase, type SampleBankSummary } from './library'
import { exportPatchJson, importPatchJson } from './patchJson'
import { exportSamplePack } from './pack'

export interface SampleForgeController {
  bank: SampleBank | null; banks: SampleBankSummary[]; selectedId: string; selected: ForgeSample | null
  draftPatch: KickPatch; preview: RenderedKick | null; baseRender: RenderedKick | null
  renderStatus: 'idle' | 'rendering' | 'ready' | 'error'; dirty: boolean; bankDirty: boolean; canUndo: boolean
  seed: number; progress: number; busyKind: 'generation' | 'export' | 'save' | 'import' | null
  previewPlaying: boolean; previewLevel: number; abSource: 'base' | 'selected'; autoPreview: boolean
  error: string | null; notice: string; filter: string; favoritesOnly: boolean; exportIds: string[]
  setSeed: (value: number) => void; setAutoPreview: (value: boolean) => void
  editPatch: (key: KickNumericParameter | 'noiseColor', value: number | string) => void
  select: (id: string) => boolean; playSelected: () => void; playBase: () => void; stopPreview: () => void; replay: () => void; playNext: () => void; toggleAB: () => void
  renderNow: () => Promise<void>; saveChanges: () => Promise<void>; resetGenerated: () => void; undo: () => void; duplicatePatch: () => Promise<void>
  exportPatch: () => Promise<void>; importPatch: (file: File) => Promise<void>
  setSampleName: (name: string) => void; setSampleTags: (tags: string[]) => void; toggleFavorite: () => void
  setFilter: (value: string) => void; setFavoritesOnly: (value: boolean) => void; toggleExportId: (id: string) => void; selectAllForExport: () => void
  saveBank: () => Promise<void>; loadBank: (id: string) => Promise<void>; deleteBank: (id: string) => Promise<void>; setBankName: (name: string) => void
  generateBatch: () => Promise<void>; regenerateBatch: () => Promise<void>; exportZIP: () => Promise<void>; cancelOperation: () => void
  updateBlockReason: () => string | null
}

const yieldUi = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const baseSelection = 'base'
const VIEW_KEY = 'sound-lab.forge-view.v1'

function download(bytes: Uint8Array<ArrayBuffer> | string, filename: string, type: string): void {
  const blob = new Blob([bytes], { type }), url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Editor drafts, committed patch/audio pairs and persistent banks are distinct. */
export function useSampleForge({ engineRef, active }: { engineRef: RefObject<SynthEngine | null>; active: boolean }): SampleForgeController {
  const [bank, setBankState] = useState<SampleBank | null>(null), bankRef = useRef<SampleBank | null>(null)
  const [banks, setBanks] = useState<SampleBankSummary[]>([])
  const [workingBase, setWorkingBase] = useState<ForgeSample | null>(null), workingRef = useRef<ForgeSample | null>(null)
  const [selectedId, setSelectedId] = useState(baseSelection), selectedRef = useRef(baseSelection)
  const [draftPatch, setDraftState] = useState(() => copyKickPatch({ ...DEFAULT_KICK_PATCH })), draftRef = useRef(draftPatch)
  const [preview, setPreview] = useState<RenderedKick | null>(null), previewRenderRef = useRef<RenderedKick | null>(null)
  const [renderStatus, setRenderStatus] = useState<SampleForgeController['renderStatus']>('idle'), renderStateRef = useRef(renderStatus)
  const [bankDirty, setBankDirtyState] = useState(false), bankDirtyRef = useRef(false)
  const [canUndo, setCanUndo] = useState(false), history = useRef<KickPatch[]>([])
  const [seed, setSeedState] = useState(202608), seedRef = useRef(seed)
  const [progress, setProgress] = useState(0)
  const [busyKind, setBusyState] = useState<SampleForgeController['busyKind']>(null), busyRef = useRef(busyKind)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [abSource, setAbSource] = useState<'base' | 'selected'>('selected'), abRef = useRef<'base' | 'selected'>('selected')
  const [autoPreview, setAutoPreviewState] = useState(true), autoRef = useRef(true)
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('Kick · 16 новых вариаций · Medium. Generate не запускает звук.')
  const [filter, setFilter] = useState(''), [favoritesOnly, setFavoritesOnly] = useState(false)
  const [exportIds, setExportIds] = useState<string[]>([]), exportIdsRef = useRef<string[]>([])
  const mounted = useRef(false), loaded = useRef(false), editorRevision = useRef(0), bankRevision = useRef(0), operationRevision = useRef(0), loadRevision = useRef(0), libraryRevision = useRef(0), previewIntent = useRef(0)
  const renderAbort = useRef<AbortController | null>(null), operationAbort = useRef<AbortController | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null), previewPlayer = useRef<SamplePreview | null>(null)

  const setBank = (value: SampleBank | null) => { bankRef.current = value; setBankState(value) }
  const setBankDirty = (value: boolean) => { bankDirtyRef.current = value; setBankDirtyState(value) }
  const setBusy = (value: SampleForgeController['busyKind']) => { busyRef.current = value; setBusyState(value) }
  const renderState = (value: SampleForgeController['renderStatus']) => { renderStateRef.current = value; setRenderStatus(value) }
  const setDraft = (value: KickPatch) => { draftRef.current = copyKickPatch(value); setDraftState(draftRef.current) }
  const selectedNow = () => selectedRef.current === baseSelection ? bankRef.current?.base ?? workingRef.current : bankRef.current ? samplesInBank(bankRef.current).find(sample => sample.id === selectedRef.current) ?? null : null
  const hasDraftChanges = () => { const current = selectedNow(); return !!current && kickPatchFingerprint(current.patch) !== kickPatchFingerprint(draftRef.current) }
  const setExportSelection = (ids: string[]) => { exportIdsRef.current = ids; setExportIds(ids) }
  const invalidateRender = () => { ++editorRevision.current; renderAbort.current?.abort(); if (debounce.current) clearTimeout(debounce.current); debounce.current = null }
  const stopPreview = () => { ++previewIntent.current; previewPlayer.current?.stop() }
  const report = (reason: unknown) => { if (mounted.current && !aborted(reason)) setError(message(reason)) }
  const refreshLibrary = async () => {
    const revision = ++libraryRevision.current
    const result = await listSampleBanks()
    if (!mounted.current || revision !== libraryRevision.current) return result.banks
    setBanks(result.banks)
    if (result.skipped) setError(`Пропущено повреждённых записей: ${result.skipped}. Исходные данные не удалены.`)
    return result.banks
  }

  async function renderCurrent(audition = false, intent = previewIntent.current, preserveError = false): Promise<RenderedKick | null> {
    renderAbort.current?.abort()
    const abort = new AbortController(), revision = editorRevision.current, id = selectedRef.current, patch = copyKickPatch(draftRef.current)
    renderAbort.current = abort; renderState('rendering'); if (!preserveError) setError(null)
    try {
      const result = await renderKick(patch, { signal: abort.signal })
      if (!mounted.current || abort.signal.aborted || revision !== editorRevision.current || id !== selectedRef.current) return null
      previewRenderRef.current = result; setPreview(result); renderState('ready')
      if (!bankRef.current && !workingRef.current && id === baseSelection) {
        const sample = createForgeSample(patch, result, { id: baseSelection, name: 'Base Kick', character: 'base' })
        sample.generatedPatch = copyKickPatch({ ...DEFAULT_KICK_PATCH })
        if (kickPatchFingerprint(patch) !== kickPatchFingerprint({ ...DEFAULT_KICK_PATCH })) setBankDirty(true)
        workingRef.current = sample; setWorkingBase(sample)
      }
      if (audition && autoRef.current && intent === previewIntent.current) { abRef.current = id === baseSelection ? 'base' : 'selected'; setAbSource(abRef.current); void previewPlayer.current?.play(result).catch(report) }
      return result
    } catch (reason) { if (mounted.current && !abort.signal.aborted && revision === editorRevision.current) { renderState('error'); report(reason) }; return null }
  }

  function scheduleDraft(next: KickPatch, remember = true) {
    if (kickPatchFingerprint(next) === kickPatchFingerprint(draftRef.current)) return
    ++loadRevision.current
    const intent = ++previewIntent.current
    if (remember) { history.current = [...history.current.slice(-31), copyKickPatch(draftRef.current)]; setCanUndo(true) }
    invalidateRender(); setDraft(next); renderState('rendering')
    if (autoRef.current) void previewPlayer.current?.prepareGesture().catch(report)
    debounce.current = setTimeout(() => { debounce.current = null; void renderCurrent(true, intent) }, 180)
  }

  function select(id: string) {
    if (id === selectedRef.current) return true
    const current = selectedNow()
    if (current && kickPatchFingerprint(current.patch) !== kickPatchFingerprint(draftRef.current) && !window.confirm('Правки патча ещё не сохранены. Перейти к другому звуку?')) return false
    const next = id === baseSelection ? bankRef.current?.base ?? workingRef.current : bankRef.current ? samplesInBank(bankRef.current).find(sample => sample.id === id) : null
    if (!next) return false
    ++loadRevision.current
    stopPreview(); invalidateRender(); selectedRef.current = id; setSelectedId(id); setDraft(next.patch)
    previewRenderRef.current = next.render; setPreview(next.render); renderState('ready'); history.current = []; setCanUndo(false); setError(null)
    return true
  }

  async function currentRender(): Promise<RenderedKick> {
    if (debounce.current) { clearTimeout(debounce.current); debounce.current = null }
    const expected = kickPatchFingerprint(draftRef.current)
    const cached = previewRenderRef.current
    const result = cached?.fingerprint === expected ? cached : await renderCurrent(false)
    if (!result || result.fingerprint !== kickPatchFingerprint(draftRef.current)) throw new DOMException('Патч изменился во время рендера.', 'AbortError')
    return result
  }

  function replaceSample(next: ForgeSample): SampleBank | null {
    const current = bankRef.current
    if (!current) { ++bankRevision.current; workingRef.current = next; setWorkingBase(next); setBankDirty(true); return null }
    const value = { ...current, base: selectedRef.current === baseSelection ? next : current.base,
      samples: current.samples.map(sample => sample.id === next.id ? next : sample), copies: current.copies.map(sample => sample.id === next.id ? next : sample), updatedAt: Date.now() }
    ++bankRevision.current; setBank(value); setBankDirty(true)
    return value
  }

  function restoreEditorSilently() {
    if (!mounted.current || renderStateRef.current !== 'idle') return
    if (previewRenderRef.current?.fingerprint === kickPatchFingerprint(draftRef.current)) renderState('ready')
    else void renderCurrent(false, previewIntent.current, true)
  }

  async function commitEditor(): Promise<{ sample: ForgeSample; bank: SampleBank | null }> {
    const id = selectedRef.current, revision = editorRevision.current
    const result = await currentRender()
    if (id !== selectedRef.current || revision !== editorRevision.current) throw new DOMException('Выбран другой патч.', 'AbortError')
    const previous = selectedNow() ?? createForgeSample(result.patch, result, { id: baseSelection, name: 'Base Kick', character: 'base' })
    const sample = { ...previous, seed: result.patch.seed, patch: copyKickPatch(result.patch), render: result, updatedAt: Date.now() }
    return { sample, bank: replaceSample(sample) }
  }

  async function saveChanges() {
    if (busyRef.current) return
    setBusy('save'); setError(null)
    try {
      const value = await commitEditor(), revision = bankRevision.current
      await yieldUi()
      if (value.bank) { await saveSampleBank(value.bank); await refreshLibrary() }
      else await saveWorkingBase(value.sample)
      if (mounted.current && revision === bankRevision.current) setBankDirty(false)
      if (mounted.current) setNotice('Save Changes: патч и соответствующий PCM/WAV сохранены локально.')
    } catch (reason) { report(reason) } finally { if (mounted.current) setBusy(null) }
  }

  async function saveBank() {
    if (!bankRef.current || busyRef.current) return
    setBusy('save'); setError(null)
    try {
      const value = await commitEditor()
      if (!value.bank) return
      const snapshot = copyBank(value.bank), revision = bankRevision.current
      await yieldUi(); await saveSampleBank(snapshot); await refreshLibrary()
      if (mounted.current && bankRef.current?.id === snapshot.id && revision === bankRevision.current) setBankDirty(false)
      if (mounted.current) { setNotice('Банк сохранён в IndexedDB вместе с WAV, патчами и метаданными.'); try { localStorage.setItem(VIEW_KEY, snapshot.id) } catch { /* Bank itself is already persisted. */ } }
    } catch (reason) { report(reason) } finally { if (mounted.current) setBusy(null) }
  }

  function adoptBank(value: SampleBank) {
    stopPreview(); invalidateRender(); setBank(value); setBankDirty(false); ++bankRevision.current
    const selected = value.samples[0]
    selectedRef.current = selected.id; setSelectedId(selected.id); setDraft(selected.patch)
    previewRenderRef.current = selected.render; setPreview(selected.render); renderState('ready'); history.current = []; setCanUndo(false)
    seedRef.current = value.batchSeed; setSeedState(value.batchSeed); setExportSelection(value.samples.map(sample => sample.id))
  }

  async function loadBank(id: string) {
    if (busyRef.current) return
    const current = selectedNow(), dirty = current && kickPatchFingerprint(current.patch) !== kickPatchFingerprint(draftRef.current)
    if ((bankDirtyRef.current || dirty) && !window.confirm('Есть несохранённые изменения. Открыть другой банк?')) return
    stopPreview(); invalidateRender(); renderState('idle')
    const revision = ++loadRevision.current
    setError(null)
    try {
      const value = await loadSampleBank(id)
      if (!mounted.current || revision !== loadRevision.current) return
      if (!value) throw new Error('Банк не найден или повреждён. Данные не удалены.')
      adoptBank(value)
      try { localStorage.setItem(VIEW_KEY, id) } catch { /* Current session works. */ }
      setNotice(`Открыт банк «${value.name}».`)
    } catch (reason) { report(reason) } finally { restoreEditorSilently() }
  }

  function cancelOperation(restore = true) {
    ++operationRevision.current; operationAbort.current?.abort(); operationAbort.current = null
    if (busyRef.current === 'generation' || busyRef.current === 'export') { setBusy(null); setProgress(0); setNotice('Операция отменена. Сохранённые банки не изменены.') }
    if (restore) restoreEditorSilently()
  }

  async function generateBatch() {
    if (busyRef.current && busyRef.current !== 'generation') return
    if (busyRef.current !== 'generation' && bankRef.current && (bankDirtyRef.current || hasDraftChanges()) && !window.confirm('Есть несохранённые изменения Sample Forge. Создать новый банк? Сохранённые банки останутся в библиотеке.')) return
    cancelOperation(false); ++loadRevision.current
    const abort = new AbortController(), operation = ++operationRevision.current
    operationAbort.current = abort
    const base = selectedRef.current === baseSelection ? copyKickPatch(draftRef.current) : copyKickPatch(bankRef.current?.base.patch ?? workingRef.current?.patch ?? { ...DEFAULT_KICK_PATCH })
    const baseMetadata = bankRef.current?.base ?? workingRef.current
    stopPreview(); invalidateRender(); renderState('idle')
    const generationSeed = seedRef.current, editRevision = editorRevision.current
    setBusy('generation'); setProgress(0); setError(null); setNotice(`Генерация Medium · Seed ${generationSeed}. Base зафиксирован в начале.`)
    try {
      const result = await generateSampleBank(base, generationSeed, { signal: abort.signal, onProgress: value => { if (mounted.current && operation === operationRevision.current) setProgress(value) } })
      if (!mounted.current || abort.signal.aborted || operation !== operationRevision.current) return
      const laterBase = selectedRef.current === baseSelection && editRevision !== editorRevision.current ? copyKickPatch(draftRef.current) : null
      if (baseMetadata) result.base = { ...result.base, name: baseMetadata.name, tags: [...baseMetadata.tags], favorite: baseMetadata.favorite }
      adoptBank(result); setBankDirty(true)
      if (laterBase) { selectedRef.current = baseSelection; setSelectedId(baseSelection); setDraft(laterBase); void renderCurrent(false) }
      setNotice('Готово: 16 новых Kick + отдельный Base. Сохраните банк; Generate не воспроизводит звуки.')
    } catch (reason) { report(reason) } finally { if (mounted.current && operation === operationRevision.current) { setBusy(null); restoreEditorSilently() } }
  }

  async function playSelected() {
    const intent = ++previewIntent.current
    void previewPlayer.current?.prepareGesture().catch(report)
    try { const result = await currentRender(); if (intent !== previewIntent.current || !mounted.current) return; abRef.current = selectedRef.current === baseSelection ? 'base' : 'selected'; setAbSource(abRef.current); await previewPlayer.current?.play(result) } catch (reason) { report(reason) }
  }
  async function playBase() {
    ++previewIntent.current
    void previewPlayer.current?.prepareGesture().catch(report)
    const result = bankRef.current?.base.render ?? workingRef.current?.render
    if (!result) { await playSelected(); return }
    abRef.current = 'base'; setAbSource('base'); await previewPlayer.current?.play(result).catch(report)
  }

  function updateMetadata(update: (sample: ForgeSample) => ForgeSample) { const sample = selectedNow(); if (!sample) return; const next = update(sample); if (next === sample) return; ++loadRevision.current; replaceSample(next) }
  async function duplicatePatch() {
    if (busyRef.current) return
    setBusy('save')
    const bankId = bankRef.current?.id, revision = editorRevision.current
    try {
      const render = await currentRender(), previous = selectedNow()
      if (revision !== editorRevision.current || bankId !== bankRef.current?.id) throw new DOMException('Патч изменён во время копирования.', 'AbortError')
      if (!bankRef.current) { setNotice('Для копии сначала создайте банк. Base можно сохранить или экспортировать как Patch JSON.'); return }
      if (bankRef.current.copies.length >= 32) throw new Error('В банке уже 32 пользовательские копии.')
      const sample = createForgeSample(render.patch, render, { name: `${previous?.name ?? 'Kick'} copy`, character: 'custom', tags: previous?.tags ?? ['Kick'] })
      const next = { ...bankRef.current, copies: [...bankRef.current.copies, sample], updatedAt: Date.now() }
      ++bankRevision.current; setBank(next); setBankDirty(true); invalidateRender(); selectedRef.current = sample.id; setSelectedId(sample.id); setDraft(sample.patch)
      previewRenderRef.current = render; setPreview(render); renderState('ready'); history.current = []; setCanUndo(false)
    } catch (reason) { report(reason) } finally { if (mounted.current) setBusy(null) }
  }

  async function exportPatch() {
    try {
      const patch = copyKickPatch(draftRef.current), sample = selectedNow()
      const portable: PortableKickPatch = { format: 'sound-lab.kick-patch', version: 1, generatorVersion: GENERATOR_VERSION,
        name: sample?.name ?? 'Base Kick', tags: sample?.tags ?? ['Kick'], character: sample?.character ?? 'base', patch, generatedPatch: copyKickPatch(sample?.generatedPatch ?? patch) }
      download(exportPatchJson(portable), 'Kick_Patch.json', 'application/json')
    } catch (reason) { report(reason) }
  }

  async function importPatch(file: File) {
    if (busyRef.current) return
    if (hasDraftChanges() && !window.confirm('Правки патча ещё не сохранены. Импортировать другой патч?')) return
    stopPreview(); invalidateRender(); renderState('idle')
    const revision = ++loadRevision.current
    setBusy('import'); setError(null)
    try {
      if (file.size > 65536) throw new Error('Patch JSON превышает 64 KiB.')
      const portable = importPatchJson(await file.text())
      const rendered = await renderKick(portable.patch)
      if (!mounted.current || revision !== loadRevision.current) return
      const sample = createForgeSample(portable.patch, rendered, { id: bankRef.current ? undefined : baseSelection, name: portable.name, character: portable.character, tags: portable.tags })
      sample.generatedPatch = copyKickPatch(portable.generatedPatch)
      if (bankRef.current) {
        if (bankRef.current.copies.length >= 32) throw new Error('В банке уже 32 пользовательские копии.')
        setBank({ ...bankRef.current, copies: [...bankRef.current.copies, sample], updatedAt: Date.now() }); ++bankRevision.current; setBankDirty(true)
      } else { workingRef.current = sample; setWorkingBase(sample); setBankDirty(true) }
      stopPreview(); invalidateRender(); selectedRef.current = bankRef.current ? sample.id : baseSelection; setSelectedId(selectedRef.current); setDraft(sample.patch)
      previewRenderRef.current = rendered; setPreview(rendered); renderState('ready'); history.current = []; setCanUndo(false)
      setNotice('Patch JSON проверен и отрендерен. Save Changes сохраняет его локально.')
    } catch (reason) { report(reason) } finally { if (mounted.current) { setBusy(null); restoreEditorSilently() } }
  }

  async function exportZIP() {
    if (!bankRef.current || busyRef.current || !exportIdsRef.current.length) return
    const sample = selectedNow()
    if (sample && kickPatchFingerprint(sample.patch) !== kickPatchFingerprint(draftRef.current)) { setError('Сначала Save Changes: ZIP экспортирует сохранённые пары Patch/WAV.'); return }
    const snapshot = copyBank(bankRef.current), ids = [...exportIdsRef.current]
    const abort = new AbortController(), operation = ++operationRevision.current
    operationAbort.current = abort; setBusy('export'); setProgress(0); setError(null)
    try {
      await yieldUi()
      const pack = await exportSamplePack(snapshot, { sampleIds: ids, signal: abort.signal, onProgress: value => { if (mounted.current && operation === operationRevision.current) setProgress(value.percent / 100) } })
      if (!mounted.current || abort.signal.aborted || operation !== operationRevision.current) return
      download(pack.bytes, pack.filename, 'application/zip'); setNotice(`ZIP готов: ${ids.length} WAV + Patch JSON, manifest и README. Исходные данные сохранены.`)
    } catch (reason) { report(reason) } finally { if (mounted.current && operation === operationRevision.current) setBusy(null) }
  }

  useEffect(() => {
    mounted.current = true
    previewPlayer.current = new SamplePreview(async () => { const engine = engineRef.current; if (!engine) return null; await engine.prepare(); return engine.getSamplePreviewBus() }, playing => { if (mounted.current) setPreviewPlaying(playing) })
    const unsubscribe = engineRef.current?.subscribeCancellation(stopPreview)
    const unsubscribeState = engineRef.current?.subscribeContextState(state => { if (state !== 'running') stopPreview() })
    const hidden = () => { if (document.hidden) stopPreview() }
    document.addEventListener('visibilitychange', hidden)
    return () => { mounted.current = false; ++operationRevision.current; ++loadRevision.current; invalidateRender(); operationAbort.current?.abort(); previewPlayer.current?.dispose(); unsubscribe?.(); unsubscribeState?.(); document.removeEventListener('visibilitychange', hidden); loaded.current = false }
  }, [engineRef])

  useEffect(() => {
    if (!active || loaded.current) return
    loaded.current = true
    const revision = ++loadRevision.current
    void (async () => {
      try {
        const summary = await refreshLibrary()
        let id: string | null = null
        try { id = localStorage.getItem(VIEW_KEY) } catch { /* Use most recent bank. */ }
        const chosen = summary.find(item => item.id === id) ?? summary[0]
        if (chosen) {
          const value = await loadSampleBank(chosen.id)
          if (mounted.current && revision === loadRevision.current && value) adoptBank(value)
        } else {
          const saved = await loadWorkingBase()
          if (!mounted.current || revision !== loadRevision.current) return
          if (saved) { workingRef.current = saved; setWorkingBase(saved); setDraft(saved.patch); previewRenderRef.current = saved.render; setPreview(saved.render); renderState('ready') }
          else await renderCurrent(false, previewIntent.current, true)
        }
      } catch (reason) { report(reason); if (mounted.current && revision === loadRevision.current) await renderCurrent(false, previewIntent.current, true) }
    })()
  }, [active])

  const selected = selectedId === baseSelection ? bank?.base ?? workingBase : bank ? samplesInBank(bank).find(sample => sample.id === selectedId) ?? null : null
  const dirty = !!selected && kickPatchFingerprint(selected.patch) !== kickPatchFingerprint(draftPatch)
  return { bank, banks, selectedId, selected, draftPatch, preview, baseRender: bank?.base.render ?? workingBase?.render ?? null, renderStatus, dirty, bankDirty, canUndo,
    seed, progress, busyKind, previewPlaying, previewLevel: 0.55, abSource, autoPreview, error, notice, filter, favoritesOnly, exportIds,
    setSeed: value => { if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) { seedRef.current = value; setSeedState(value) } else setError('Seed: целое число от 0 до 4294967295.') },
    setAutoPreview: value => { autoRef.current = value; setAutoPreviewState(value) },
    editPatch: (key, value) => scheduleDraft(normalizeKickPatch({ ...draftRef.current, [key]: value })), select, playSelected: () => void playSelected(), playBase: () => void playBase(), stopPreview,
    replay: () => { if (abRef.current === 'base') void playBase(); else void playSelected() },
    playNext: () => { const samples = bankRef.current?.samples ?? []; if (!samples.length) return; const index = samples.findIndex(item => item.id === selectedRef.current); const next = samples[(index + 1) % samples.length]; if (select(next.id)) void playSelected() },
    toggleAB: () => { if (abRef.current === 'base') void playSelected(); else void playBase() }, renderNow: async () => { if (debounce.current) clearTimeout(debounce.current); debounce.current = null; await renderCurrent(false) }, saveChanges,
    resetGenerated: () => { const value = selectedNow(); if (value) scheduleDraft(value.generatedPatch) },
    undo: () => { const value = history.current.pop(); setCanUndo(history.current.length > 0); if (value) scheduleDraft(value, false) }, duplicatePatch, exportPatch, importPatch,
    setSampleName: name => { const value = name.trim().slice(0, 120); if (value) updateMetadata(sample => value === sample.name ? sample : ({ ...sample, name: value, updatedAt: Date.now() })) },
    setSampleTags: tags => { try { const normalized = normalizeTags(tags); updateMetadata(sample => normalized.join('\0') === sample.tags.join('\0') ? sample : ({ ...sample, tags: normalized, updatedAt: Date.now() })) } catch (reason) { report(reason) } }, toggleFavorite: () => updateMetadata(sample => ({ ...sample, favorite: !sample.favorite, updatedAt: Date.now() })),
    setFilter, setFavoritesOnly, toggleExportId: id => setExportSelection(exportIdsRef.current.includes(id) ? exportIdsRef.current.filter(value => value !== id) : [...exportIdsRef.current, id]),
    selectAllForExport: () => setExportSelection(bankRef.current?.samples.map(sample => sample.id) ?? []), saveBank, loadBank,
    deleteBank: async id => { if (busyRef.current || !window.confirm('Удалить этот Sample Bank из локальной библиотеки? Сначала сохраните ZIP, если он нужен.')) return; try { await deleteSampleBank(id); await refreshLibrary(); if (bankRef.current?.id === id) { setBankDirty(true); setNotice('Банк удалён из библиотеки. Текущая копия остаётся в памяти до закрытия. Save Bank восстановит её.') } } catch (reason) { report(reason) } },
    setBankName: name => { const value = name.trim().slice(0, 120); if (bankRef.current && value && value !== bankRef.current.name) { ++loadRevision.current; ++bankRevision.current; setBank({ ...bankRef.current, name: value, updatedAt: Date.now() }); setBankDirty(true) } },
    generateBatch, regenerateBatch: generateBatch, exportZIP, cancelOperation,
    updateBlockReason: () => { const current = selectedNow(); if (busyRef.current || renderStateRef.current === 'rendering') return 'Дождитесь завершения или отмените операцию Sample Forge.'; if (previewPlayer.current?.diagnostics().activeSources) return 'Остановите Preview перед обновлением.'; if (bankDirtyRef.current || (current && kickPatchFingerprint(current.patch) !== kickPatchFingerprint(draftRef.current))) return 'Сохраните изменения Sample Forge перед обновлением.'; return null },
  }
}
