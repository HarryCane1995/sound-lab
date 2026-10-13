import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { startTestBrowser, testBrowserName } from './helpers.mjs'

const browserName = testBrowserName()
const session = await startTestBrowser()
try {
  const report = await session.page.evaluate(async () => {
    const { renderKick, getKickRendererDiagnostics, KICK_PEAK_CEILING, finalizeKickPcm } = await import('/src/sample-forge/audio/KickRenderer.ts')
    const { encodeWav24 } = await import('/src/sample-forge/audio/WavEncoder.ts')
    const { DEFAULT_KICK_PATCH, KICK_PARAMETER_RANGES, normalizeKickPatch, validateKickPatch, kickPatchFingerprint, seededRandom } = await import('/src/sample-forge/kickPatch.ts')
    const results = []
    const check = (name, metrics, assertions) => results.push({ name, metrics, checks: assertions.map(([description, passed]) => ({ description, passed: Boolean(passed) })) })
    const render = changes => renderKick({ ...DEFAULT_KICK_PATCH, ...changes })
    const independentMetrics = pcm => {
      let peak = 0, sum = 0, power = 0, maximumStep = 0
      for (let i = 0; i < pcm.length; ++i) { peak = Math.max(peak, Math.abs(pcm[i])); sum += pcm[i]; power += pcm[i] ** 2; if (i) maximumStep = Math.max(maximumStep, Math.abs(pcm[i] - pcm[i - 1])) }
      return { peak, dc: sum / pcm.length, rms: Math.sqrt(power / pcm.length), maximumStep, finite: pcm.every(Number.isFinite) }
    }
    const windowRms = (pcm, start, end) => independentMetrics(pcm.subarray(Math.round(start * 48000), Math.min(pcm.length, Math.round(end * 48000)))).rms
    const crossingFrequency = (pcm, start, end) => {
      const crossings = []
      for (let i = Math.max(1, Math.round(start * 48000)); i < Math.min(pcm.length, end * 48000); ++i) if (pcm[i - 1] <= 0 && pcm[i] > 0) crossings.push(i - 1 - pcm[i - 1] / (pcm[i] - pcm[i - 1]))
      return { hz: crossings.length > 1 ? (crossings.length - 1) * 48000 / (crossings.at(-1) - crossings[0]) : 0, crossings: crossings.length }
    }
    // Independent direct DFT checks selected bins of actual PCM. Production's
    // radix-2 FFT/features are not used as the oracle for drive/tone/transient.
    const dft = (pcm, hz, start = 0, duration = 0.04) => {
      const begin = Math.round(start * 48000), length = Math.min(Math.round(duration * 48000), pcm.length - begin)
      let real = 0, imaginary = 0
      for (let i = 0; i < length; ++i) {
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.max(1, length - 1))
        const angle = 2 * Math.PI * hz * i / 48000
        real += pcm[begin + i] * window * Math.cos(angle); imaginary -= pcm[begin + i] * window * Math.sin(angle)
      }
      return (real ** 2 + imaginary ** 2) / Math.max(1, length ** 2)
    }
    const bandPower = (pcm, min, max, start = 0, duration = 0.04) => {
      let power = 0
      for (let hz = min; hz <= max; hz += 125) power += dft(pcm, hz, start, duration)
      return power
    }
    const same = (a, b) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
    const defaultKick = await render()
    const defaultMetrics = independentMetrics(defaultKick.pcm)
    check('Default Kick is a completed native 48 kHz mono one-shot', { ...defaultKick.metrics, independent: defaultMetrics }, [
      ['default sound is nonempty and 300–700 ms', defaultKick.sampleRate === 48000 && defaultKick.pcm instanceof Float32Array && defaultKick.metrics.duration >= 0.3 && defaultKick.metrics.duration <= 0.7 && defaultMetrics.rms > 0.02],
      ['reported Peak/RMS/DC are measured from final PCM', Math.abs(defaultMetrics.peak - defaultKick.metrics.peak) < 1e-12 && Math.abs(defaultMetrics.rms - defaultKick.metrics.rms) < 1e-12 && Math.abs(defaultMetrics.dc - defaultKick.metrics.dcOffset) < 1e-12],
      ['spectral features contain a low-frequency body', defaultKick.metrics.spectralCentroidHz > 30 && defaultKick.metrics.spectralCentroidHz < 1000 && defaultKick.metrics.lowBandRatio > 0.5],
      ['native renderer has released all graph connections', getKickRendererDiagnostics().active === 0 && getKickRendererDiagnostics().connectedNodes === 0],
    ])

    const clean = await render({ drive: 0, clickAmount: 0, tone: 16000 })
    const earlyFrequency = crossingFrequency(clean.pcm, 0.003, 0.05)
    const lateFrequency = crossingFrequency(clean.pcm, 0.1, 0.24)
    check('Pitch falls through real scheduled OscillatorNode frequency automation', { earlyFrequency, lateFrequency }, [
      ['early cycles are faster than the settled body', earlyFrequency.crossings >= 3 && lateFrequency.crossings >= 5 && earlyFrequency.hz > lateFrequency.hz * 1.25],
      ['settled cycles match End Frequency 55 Hz', Math.abs(lateFrequency.hz - 55) < 1.5],
    ])

    const fastPitch = await render({ drive: 0, clickAmount: 0, pitchDecay: 30, pitchCurve: 0.3 })
    const slowPitch = await render({ drive: 0, clickAmount: 0, pitchDecay: 150, pitchCurve: 3 })
    const fastMiddle = crossingFrequency(fastPitch.pcm, 0.03, 0.12), slowMiddle = crossingFrequency(slowPitch.pcm, 0.03, 0.12)
    check('Pitch Curve and Decay alter the actual pitch contour', { fastMiddle, slowMiddle }, [
      ['slower contour retains more mid-attack pitch', slowMiddle.hz > fastMiddle.hz * 1.5],
      ['contours do not change the stored endpoint', fastPitch.patch.endFrequency === 55 && slowPitch.patch.endFrequency === 55],
    ])

    const steady = await render({ startFrequency: 110, endFrequency: 100, drive: 0, clickAmount: 0, bodyDecay: 350 })
    const levels = [windowRms(steady.pcm, 0.005, 0.045), windowRms(steady.pcm, 0.12, 0.16), windowRms(steady.pcm, 0.3, 0.34)]
    const fastAttack = await render({ attack: 0, drive: 0, clickAmount: 0 }), slowAttack = await render({ attack: 20, drive: 0, clickAmount: 0 })
    // Native oversampling filters have a common pipeline delay. Measure both
    // attacks in the same onset-relative window instead of measuring silence.
    const pipelineOnset = fastAttack.pcm.findIndex(value => Math.abs(value) > 1e-4) / 48000
    const attackLevels = [windowRms(fastAttack.pcm, pipelineOnset, pipelineOnset + 0.002), windowRms(slowAttack.pcm, pipelineOnset, pipelineOnset + 0.002)]
    check('One-shot amplitude envelope preserves Attack and musical decay duration', { levels, attackLevels, pipelineOnset }, [
      ['body level decays without Note Off', levels[0] > levels[1] * 3 && levels[1] > levels[2] * 5],
      ['350 ms is duration to approximately −60 dB, not a multi-second time constant', steady.metrics.duration < 0.45 && levels[2] < levels[0] * 0.01],
      ['slow Attack reduces the first two onset-relative milliseconds as requested', attackLevels[0] > attackLevels[1] * 4 && pipelineOnset < 0.01],
    ])

    const withClick = await render({ drive: 0, clickAmount: 1, tone: 16000, seed: 901 })
    const withoutClick = await render({ drive: 0, clickAmount: 0, tone: 16000, seed: 901 })
    const transientPower = [bandPower(withClick.pcm, 2000, 16000), bandPower(withoutClick.pcm, 2000, 16000)]
    const transientLate = bandPower(withClick.pcm, 2000, 16000, 0.08)
    check('Click Amount controls a short filtered synthetic transient', { transientPower, transientLate }, [
      ['click introduces real high-band energy', transientPower[0] > transientPower[1] * 20 && transientPower[0] > 1e-8],
      ['high-frequency transient ends instead of becoming sustained noise', transientLate < transientPower[0] * 0.01],
    ])

    const driveClean = await render({ startFrequency: 100, endFrequency: 100, bodyDecay: 900, clickAmount: 0, drive: 0, tone: 16000 })
    const driveHot = await render({ startFrequency: 100, endFrequency: 100, bodyDecay: 900, clickAmount: 0, drive: 1, tone: 16000 })
    const thirdRatios = [driveClean, driveHot].map(result => Math.sqrt(dft(result.pcm, 300, 0.02, 0.12) / dft(result.pcm, 100, 0.02, 0.12)))
    check('Oversampled WaveShaper Drive adds measured body harmonics', { thirdRatios, centroids: [driveClean.metrics.spectralCentroidHz, driveHot.metrics.spectralCentroidHz] }, [
      ['clean sine has little third-harmonic energy', thirdRatios[0] < 0.01],
      ['Drive increases its third harmonic', thirdRatios[1] > thirdRatios[0] + 0.06],
      ['saturation output stays below digital full scale', driveHot.metrics.peak <= KICK_PEAK_CEILING + 1e-7],
    ])

    const dark = await render({ clickAmount: 1, drive: 0.3, tone: 500, seed: 811 })
    const bright = await render({ clickAmount: 1, drive: 0.3, tone: 16000, seed: 811 })
    const tonePower = [bandPower(dark.pcm, 2000, 16000), bandPower(bright.pcm, 2000, 16000)]
    check('Tone controls the final PCM spectrum', { tonePower, centroids: [dark.metrics.spectralCentroidHz, bright.metrics.spectralCentroidHz] }, [
      ['low Tone removes high-band attack energy', tonePower[1] > tonePower[0] * 10],
      ['bright file retains a higher measured spectral centroid', bright.metrics.spectralCentroidHz > dark.metrics.spectralCentroidHz],
    ])

    const colors = []
    for (const noiseColor of ['white', 'pink', 'brown']) colors.push(await render({ noiseColor, clickAmount: 1, drive: 0, seed: 777 }))
    const colorPowers = colors.map(result => bandPower(result.pcm, 2000, 10000))
    check('Noise Color changes deterministic transient spectrum', { colorPowers }, [
      ['three colors create distinct real PCM', !same(colors[0].pcm, colors[1].pcm) && !same(colors[1].pcm, colors[2].pcm)],
      ['white noise is brighter than brown after controlled filtering', colorPowers[0] > colorPowers[2] * 2],
    ])

    const maximumPatch = { ...DEFAULT_KICK_PATCH, ...Object.fromEntries(Object.entries(KICK_PARAMETER_RANGES).map(([key, range]) => [key, range.max])) }
    const minimumPatch = { ...DEFAULT_KICK_PATCH, ...Object.fromEntries(Object.entries(KICK_PARAMETER_RANGES).map(([key, range]) => [key, range.min])), outputLevel: 0.7 }
    const extremes = [await renderKick(maximumPatch), await renderKick(minimumPatch)]
    const quiet = await render({ outputLevel: 0.03 }), silent = await render({ outputLevel: 0 })
    const quietRatio = quiet.metrics.peak / defaultKick.metrics.peak
    check('Extremes, quiet output and zero output are finite and protected', { extremes: extremes.map(value => value.metrics), quietRatio, silent: silent.metrics }, [
      ['extreme valid patches remain finite and shorter than 1.1 seconds', extremes.every(value => value.pcm.every(Number.isFinite) && value.metrics.duration > 0.05 && value.metrics.duration < 1.1)],
      ['peak guard enforces at least 1 dB headroom', extremes.every(value => value.metrics.peak <= KICK_PEAK_CEILING + 1e-7)],
      ['quiet Output Level is never normalized upward', quiet.metrics.attenuationDb === 0 && Math.abs(quietRatio - 0.03 / 0.7) < 0.002],
      ['zero Output Level gives exact silence and finite displayed metrics', silent.pcm.every(value => value === 0) && silent.metrics.peak === 0 && silent.metrics.rms === 0 && Object.values(silent.metrics).every(Number.isFinite)],
    ])

    const allAudio = [defaultKick, clean, withClick, driveHot, ...extremes]
    const boundaries = allAudio.map(value => {
      const p = value.pcm
      return { dc: independentMetrics(p).dc, first: p[0], last: p.at(-1), firstStep: Math.abs(p[1] - p[0]), lastStep: Math.abs(p.at(-1) - p.at(-2)), tailPeak: Math.max(...p.subarray(-48).map(Math.abs)) }
    })
    check('DC and start/end boundaries are safe without erasing drum attack', { boundaries }, [
      ['all finite files have negligible exported DC offset', boundaries.every(value => Math.abs(value.dc) < 1e-7)],
      ['files begin and end at exact zero', boundaries.every(value => value.first === 0 && value.last === 0)],
      ['boundary steps stay far below normal musical attack', boundaries.every(value => value.firstStep < 0.002 && value.lastStep < 0.002 && value.tailPeak < 0.002)],
      ['transient remains present after technical fades', transientPower[0] > 1e-8],
    ])

    const repeated = await render()
    const changedSeed = await render({ seed: DEFAULT_KICK_PATCH.seed + 1 })
    const seedA = seededRandom(0), seedB = seededRandom(0)
    const randomA = Array.from({ length: 32 }, seedA), randomB = Array.from({ length: 32 }, seedB)
    check('Same browser, patch and seed produce bit-identical rendered PCM', { frames: repeated.pcm.length, fingerprint: repeated.fingerprint }, [
      ['re-render exactly repeats each Float32 PCM sample', same(defaultKick.pcm, repeated.pcm)],
      ['WAV source and bytes repeat exactly', same(defaultKick.wav, repeated.wav) && repeated.fingerprint === kickPatchFingerprint(DEFAULT_KICK_PATCH)],
      ['changed seed changes the noise layer', !same(defaultKick.pcm, changedSeed.pcm) && defaultKick.fingerprint !== changedSeed.fingerprint],
      ['seed zero is valid and deterministic', same(randomA, randomB) && randomA.every(value => value >= 0 && value < 1)],
    ])

    const parsed = (() => {
      const bytes = defaultKick.wav, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const string = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length))
      let cursor = 12, format = null, data = null
      while (cursor + 8 <= bytes.length) {
        const id = string(cursor, 4), size = view.getUint32(cursor + 4, true), offset = cursor + 8
        if (id === 'fmt ') format = { pcm: view.getUint16(offset, true), channels: view.getUint16(offset + 2, true), sampleRate: view.getUint32(offset + 4, true), byteRate: view.getUint32(offset + 8, true), align: view.getUint16(offset + 12, true), bits: view.getUint16(offset + 14, true) }
        if (id === 'data') data = { offset, size }
        cursor = offset + size + (size & 1)
      }
      let maxError = 0
      for (let i = 0; i < data.size / 3; ++i) {
        const offset = data.offset + i * 3
        let integer = bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16
        if (integer & 0x800000) integer -= 0x1000000
        const decoded = integer / (integer < 0 ? 0x800000 : 0x7fffff)
        maxError = Math.max(maxError, Math.abs(decoded - defaultKick.pcm[i]))
      }
      return { riff: string(0, 4), wave: string(8, 4), riffSize: view.getUint32(4, true), fileBytes: bytes.length, format, data, maxError }
    })()
    const decoder = new OfflineAudioContext(1, 1, 48000)
    const decodedNative = await decoder.decodeAudioData(defaultKick.wav.slice().buffer)
    let nativeMaximumError = 0
    for (let index = 0; index < defaultKick.pcm.length; ++index) nativeMaximumError = Math.max(nativeMaximumError, Math.abs(decodedNative.getChannelData(0)[index] - defaultKick.pcm[index]))
    check('Independent RIFF parser and native decoder verify PCM24 WAV', { parsed, decoded: { rate: decodedNative.sampleRate, channels: decodedNative.numberOfChannels, frames: decodedNative.length, nativeMaximumError } }, [
      ['RIFF/WAVE and RIFF size are correct', parsed.riff === 'RIFF' && parsed.wave === 'WAVE' && parsed.riffSize + 8 === parsed.fileBytes],
      ['fmt is signed PCM24 mono 48 kHz with correct stride', parsed.format.pcm === 1 && parsed.format.channels === 1 && parsed.format.sampleRate === 48000 && parsed.format.byteRate === 144000 && parsed.format.align === 3 && parsed.format.bits === 24],
      ['data chunk contains exactly one 24-bit sample per preview frame', parsed.data.size === defaultKick.pcm.length * 3 && parsed.maxError <= 1 / 0x7fffff],
      ['browser audio decoder opens the exported WAV with matching duration', decodedNative.sampleRate === 48000 && decodedNative.numberOfChannels === 1 && decodedNative.length === defaultKick.pcm.length && nativeMaximumError < 3e-7],
    ])

    const edgePcm = new Float32Array([-1, -0.5, 0, 0.5, 1])
    const edgeWav = encodeWav24(edgePcm), edgeView = new DataView(edgeWav.buffer)
    let rejectedNonfinite = false, rejectedClipping = false, rejectedPatch = false
    try { encodeWav24(new Float32Array([NaN])) } catch { rejectedNonfinite = true }
    try { encodeWav24(new Float32Array([1.01])) } catch { rejectedClipping = true }
    try { validateKickPatch({ ...DEFAULT_KICK_PATCH, endFrequency: 100, startFrequency: 70 }) } catch { rejectedPatch = true }
    const recovery = normalizeKickPatch({ ...DEFAULT_KICK_PATCH, attack: -1, drive: Infinity, tone: NaN, seed: -1, startFrequency: 70, endFrequency: 100 })
    const protectedPcm = finalizeKickPcm(new Float32Array([0, 2, -2, 0, 2, -2, 0, 0]), 48000)
    check('WAV edge values, odd chunk padding and invalid-data rejection', { edgeBytes: [...edgeWav.subarray(44)], recovery, protectedPeak: independentMetrics(protectedPcm.pcm).peak }, [
      ['PCM24 encodes signed endpoints and pads an odd data chunk', edgeView.getUint32(40, true) === 15 && edgeWav.length === 60 && edgeWav[44] === 0 && edgeWav[46] === 128 && edgeWav[58] === 127 && edgeWav[59] === 0],
      ['invalid PCM cannot enter a WAV', rejectedNonfinite && rejectedClipping],
      ['untrusted patch validates strictly while UI recovery stays safe', rejectedPatch && recovery.attack === 0 && recovery.drive === DEFAULT_KICK_PATCH.drive && recovery.tone === DEFAULT_KICK_PATCH.tone && recovery.startFrequency >= recovery.endFrequency && recovery.seed === DEFAULT_KICK_PATCH.seed],
      ['emergency protection attenuates only', protectedPcm.attenuationDb <= 0 && independentMetrics(protectedPcm.pcm).peak <= KICK_PEAK_CEILING + 1e-7],
    ])

    const beforeCancel = getKickRendererDiagnostics()
    const cancel = new AbortController(); cancel.abort()
    let cancelled = false
    try { await renderKick({ ...DEFAULT_KICK_PATCH }, { signal: cancel.signal }) } catch (error) { cancelled = error.name === 'AbortError' }
    const mutable = { ...DEFAULT_KICK_PATCH }
    const snapshotPromise = renderKick(mutable)
    mutable.startFrequency = 400
    const queued = Array.from({ length: 6 }, (_, index) => render({ seed: index }))
    const snapshot = await snapshotPromise
    await Promise.all(queued)
    const afterQueue = getKickRendererDiagnostics()
    check('Offline work is cancellable, snapshotted and globally bounded', { beforeCancel, afterQueue, snapshotStartFrequency: snapshot.patch.startFrequency }, [
      ['already cancelled work creates no native context', cancelled && afterQueue.contextsCreated - beforeCancel.contextsCreated === 7],
      ['mutating caller state does not change an enqueued patch', snapshot.patch.startFrequency === DEFAULT_KICK_PATCH.startFrequency],
      ['rapid requests never run more than one native offline context', afterQueue.maxActive === 1],
      ['all completed graphs and queued references release', afterQueue.active === 0 && afterQueue.queued === 0 && afterQueue.connectedNodes === 0 && afterQueue.failed === 0],
    ])
    return { browser: navigator.userAgent, scenarios: results.length, results, diagnostics: getKickRendererDiagnostics() }
  })
  await mkdir('test-results', { recursive: true })
  await writeFile(`test-results/sample-forge-audio-${browserName}.json`, JSON.stringify(report, null, 2))
  for (const result of report.results) {
    for (const check of result.checks) assert.ok(check.passed, `${result.name}: ${check.description}\n${JSON.stringify(result.metrics, null, 2)}`)
    console.log(`PASS ${result.name}`)
  }
  const assertions = report.results.reduce((sum, result) => sum + result.checks.length, 0)
  console.log(`PASS Sample Forge native audio: ${report.scenarios} scenarios / ${assertions} assertions (${browserName})`)
} finally { await session.close() }
