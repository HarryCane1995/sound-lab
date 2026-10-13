import { kickPatchFingerprint, normalizeKickPatch, type KickPatch } from '../kickPatch'
import { KickSynth, kickRenderSeconds, type ScheduledKick } from './KickSynth'
import { amplitudeDbfs, measureKickPcm, type KickAudioMetrics } from './features'
import { encodeWav24 } from './WavEncoder'

export const KICK_SAMPLE_RATE = 48000
export const KICK_PEAK_CEILING = 10 ** (-1 / 20)
export interface RenderedKick {
  patch: KickPatch
  pcm: Float32Array<ArrayBuffer>
  sampleRate: 48000
  metrics: KickAudioMetrics
  fingerprint: string
  wav: Uint8Array<ArrayBuffer>
}
export interface KickRenderOptions { signal?: AbortSignal }
let queue: Promise<void> = Promise.resolve()
const diagnostics = { active: 0, queued: 0, completed: 0, failed: 0, cancelled: 0, contextsCreated: 0, maxActive: 0, connectedNodes: 0 }
export function getKickRendererDiagnostics() { return { ...diagnostics } }

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Рендер Kick отменён.', 'AbortError')
}

/** No quiet variant is boosted. Short boundaries retain the musical transient. */
export function finalizeKickPcm(input: Float32Array, sampleRate: number): { pcm: Float32Array<ArrayBuffer>; attenuationDb: number } {
  let sourcePeak = 0, lastAudible = -1
  for (const value of input) {
    if (!Number.isFinite(value)) throw new Error('OfflineAudioContext вернул некорректный PCM.')
    sourcePeak = Math.max(sourcePeak, Math.abs(value))
  }
  if (sourcePeak === 0) return { pcm: new Float32Array(Math.min(input.length, Math.ceil(sampleRate * 0.004))), attenuationDb: 0 }
  const silenceThreshold = Math.max(1e-7, sourcePeak * 1e-5)
  for (let index = input.length - 1; index >= 0; --index) if (Math.abs(input[index]) > silenceThreshold) { lastAudible = index; break }
  const endFade = Math.round(sampleRate * 0.004)
  const length = Math.min(input.length, Math.max(endFade * 2, lastAudible + endFade + 1))
  const pcm = new Float32Array(input.subarray(0, length))
  const startFade = Math.round(sampleRate * 0.00025)
  let sum = 0, weightSum = 0
  for (let index = 0; index < pcm.length; ++index) {
    const fade = Math.min(1, index / startFade, (pcm.length - 1 - index) / endFade)
    pcm[index] *= Math.max(0, fade)
    sum += pcm[index]
    weightSum += Math.sin(Math.PI * index / (pcm.length - 1)) ** 2
  }
  // A native 10 Hz DC blocker removes steady DC. A tiny windowed residual
  // correction makes the finite exported one-shot zero-mean without introducing
  // a step at either endpoint. It is not a loudness normalizer.
  const correction = sum / Math.max(1, weightSum)
  let peak = 0
  for (let index = 0; index < pcm.length; ++index) {
    pcm[index] -= correction * Math.sin(Math.PI * index / (pcm.length - 1)) ** 2
    peak = Math.max(peak, Math.abs(pcm[index]))
  }
  const attenuation = peak > KICK_PEAK_CEILING ? KICK_PEAK_CEILING / peak : 1
  if (attenuation < 1) for (let index = 0; index < pcm.length; ++index) pcm[index] *= attenuation
  // Do not depend on denormal behavior at the WAV/preview boundaries.
  pcm[0] = 0; pcm[pcm.length - 1] = 0
  return { pcm, attenuationDb: amplitudeDbfs(attenuation) }
}

async function renderNative(patch: KickPatch, options: KickRenderOptions): Promise<RenderedKick> {
  if (options.signal?.aborted) { ++diagnostics.cancelled; checkCancelled(options.signal) }
  let graph: ScheduledKick | null = null
  ++diagnostics.active
  diagnostics.maxActive = Math.max(diagnostics.maxActive, diagnostics.active)
  try {
    const frames = Math.ceil(kickRenderSeconds(patch) * KICK_SAMPLE_RATE)
    const context = new OfflineAudioContext(1, frames, KICK_SAMPLE_RATE)
    ++diagnostics.contextsCreated
    graph = KickSynth.schedule(context, context.destination, patch)
    diagnostics.connectedNodes += graph.nodeCount
    // Native rendering cannot be forcibly closed; cancellation invalidates its
    // result and the serial queue waits for its bounded render to finish.
    const rendered = await context.startRendering()
    checkCancelled(options.signal)
    if (context.state !== 'closed') throw new Error('OfflineAudioContext не завершил рендер Kick.')
    const { pcm, attenuationDb } = finalizeKickPcm(rendered.getChannelData(0), KICK_SAMPLE_RATE)
    const result: RenderedKick = { patch: { ...patch }, pcm, sampleRate: KICK_SAMPLE_RATE,
      metrics: measureKickPcm(pcm, KICK_SAMPLE_RATE, attenuationDb), fingerprint: kickPatchFingerprint(patch), wav: encodeWav24(pcm, KICK_SAMPLE_RATE) }
    ++diagnostics.completed
    return result
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') ++diagnostics.cancelled
    else ++diagnostics.failed
    throw error
  } finally {
    if (graph) { graph.dispose(); diagnostics.connectedNodes -= graph.nodeCount }
    --diagnostics.active
  }
}

/** Globally bounded native offline work, with a snapshot captured at the call. */
export function renderKick(input: KickPatch, options: KickRenderOptions = {}): Promise<RenderedKick> {
  const patch = normalizeKickPatch(input)
  ++diagnostics.queued
  const result = queue.then(async () => {
    --diagnostics.queued
    return renderNative(patch, options)
  })
  queue = result.then(() => undefined, () => undefined)
  return result
}
