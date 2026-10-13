import { normalizeKickPatch, seededRandom, type KickPatch } from '../kickPatch'

export interface ScheduledKick {
  endTime: number
  nodeCount: number
  dispose: () => void
}

export function kickRenderSeconds(patch: KickPatch): number {
  // Body Decay is the duration to -60 dB, not an exponential time constant.
  return Math.max((patch.attack + patch.bodyDecay + 4) / 1000, (patch.clickDecay + 1) / 1000) + 0.045
}

/** One native offline graph; no SynthVoice, Note Off or musical context needed. */
export class KickSynth {
  static schedule(context: BaseAudioContext, destination: AudioNode, input: KickPatch, startTime = 0): ScheduledKick {
    const patch = normalizeKickPatch(input)
    const start = Math.max(0, startTime)
    const body = context.createOscillator()
    const bodyEnvelope = context.createGain()
    const click = context.createBufferSource()
    const clickFilter = context.createBiquadFilter()
    const clickEnvelope = context.createGain()
    const mix = context.createGain()
    const saturation = context.createWaveShaper()
    const tone = context.createBiquadFilter()
    const dcBlock = context.createBiquadFilter()
    const output = context.createGain()
    const nodes: AudioNode[] = [body, bodyEnvelope, click, clickFilter, clickEnvelope, mix, saturation, tone, dcBlock, output]
    const end = start + kickRenderSeconds(patch)
    const bodyAttack = Math.max(0.00035, patch.attack / 1000)
    const bodyDecayEnd = start + bodyAttack + patch.bodyDecay / 1000

    body.type = 'sine'
    const pitch = new Float32Array(1024)
    for (let index = 0; index < pitch.length; ++index) {
      const progress = (index / (pitch.length - 1)) ** patch.pitchCurve
      pitch[index] = patch.startFrequency * (patch.endFrequency / patch.startFrequency) ** progress
    }
    body.frequency.setValueCurveAtTime(pitch, start, patch.pitchDecay / 1000)
    body.frequency.setValueAtTime(patch.endFrequency, start + patch.pitchDecay / 1000)
    bodyEnvelope.gain.setValueAtTime(0, start)
    bodyEnvelope.gain.linearRampToValueAtTime(0.7, start + bodyAttack)
    bodyEnvelope.gain.exponentialRampToValueAtTime(0.0007, bodyDecayEnd)
    bodyEnvelope.gain.linearRampToValueAtTime(0, bodyDecayEnd + 0.004)

    const clickDuration = (patch.clickDecay + 1) / 1000
    const noiseBuffer = context.createBuffer(1, Math.ceil(clickDuration * context.sampleRate), context.sampleRate)
    const noise = noiseBuffer.getChannelData(0)
    const random = seededRandom(patch.seed)
    // Fixed, deterministic color filters. A native high-pass then keeps the
    // transient above the sub body; none of this reads recorded audio assets.
    let pink0 = 0, pink1 = 0, pink2 = 0, brown = 0
    for (let index = 0; index < noise.length; ++index) {
      const white = random() * 2 - 1
      if (patch.noiseColor === 'pink') {
        pink0 = 0.99765 * pink0 + white * 0.099046
        pink1 = 0.963 * pink1 + white * 0.2965164
        pink2 = 0.57 * pink2 + white * 1.0526913
        noise[index] = Math.max(-1, Math.min(1, (pink0 + pink1 + pink2 + white * 0.1848) * 0.18))
      } else if (patch.noiseColor === 'brown') {
        brown = (brown + white * 0.055) / 1.025
        noise[index] = Math.max(-1, Math.min(1, brown * 3.1))
      } else noise[index] = white
    }
    click.buffer = noiseBuffer
    clickFilter.type = 'highpass'
    clickFilter.frequency.value = patch.noiseColor === 'white' ? 1500 : patch.noiseColor === 'pink' ? 800 : 350
    clickFilter.Q.value = -3.0103
    clickEnvelope.gain.setValueAtTime(0, start)
    clickEnvelope.gain.linearRampToValueAtTime(patch.clickAmount * 0.25, start + 0.00025)
    clickEnvelope.gain.exponentialRampToValueAtTime(Math.max(1e-7, patch.clickAmount * 0.000025), start + patch.clickDecay / 1000)
    clickEnvelope.gain.linearRampToValueAtTime(0, start + clickDuration)
    // A muted click must stay exactly zero, including its exponential endpoint.
    if (patch.clickAmount === 0) {
      clickEnvelope.gain.cancelScheduledValues(start)
      clickEnvelope.gain.setValueAtTime(0, start)
    }

    const curve = new Float32Array(8193)
    const gain = 1 + patch.drive * 8
    const normalization = Math.tanh(gain)
    for (let index = 0; index < curve.length; ++index) {
      const value = index / (curve.length - 1) * 2 - 1
      curve[index] = patch.drive === 0 ? value : Math.tanh(value * gain) / normalization
    }
    saturation.curve = curve
    saturation.oversample = '4x'
    tone.type = 'lowpass'
    tone.frequency.value = Math.min(patch.tone, context.sampleRate * 0.45)
    tone.Q.value = -3.0103
    dcBlock.type = 'highpass'
    dcBlock.frequency.value = 10
    dcBlock.Q.value = -3.0103
    output.gain.value = patch.outputLevel * 0.9

    body.connect(bodyEnvelope).connect(mix)
    click.connect(clickFilter).connect(clickEnvelope).connect(mix)
    mix.connect(saturation).connect(tone).connect(dcBlock).connect(output).connect(destination)
    body.start(start)
    body.stop(bodyDecayEnd + 0.005)
    click.start(start)
    click.stop(start + clickDuration + 0.001)
    let disposed = false
    return {
      endTime: end, nodeCount: nodes.length,
      dispose: () => {
        if (disposed) return
        disposed = true
        for (const source of [body, click]) { try { source.stop() } catch { /* Already ended. */ } }
        for (const node of nodes) node.disconnect()
        click.buffer = null
        saturation.curve = null
      },
    }
  }
}
