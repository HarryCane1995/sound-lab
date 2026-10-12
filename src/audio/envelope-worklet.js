// One warm source supplies twenty independent audio-rate envelope channels.
// Native GainNode.gain timelines remain untouched during musical playback.
const MAX_LANES = 20
const MAX_PLAN_RAMPS = 128
const LATE_BLEND_SECONDS = 0.004

function valueAt(ramps, time) {
  for (let index = 0; index < ramps.length; index++) {
    const ramp = ramps[index]
    if (time > ramp.end) continue
    if (time <= ramp.start) return ramp.from
    if (ramp.end <= ramp.start) return ramp.to
    return ramp.from + (ramp.to - ramp.from) * (time - ramp.start) / (ramp.end - ramp.start)
  }
  return ramps.length ? ramps[ramps.length - 1].to : 0
}

function validPlan(message) {
  if (!message || !Number.isFinite(message.at) || !Number.isSafeInteger(message.revision)
    || !Array.isArray(message.ramps) || message.ramps.length > MAX_PLAN_RAMPS) return false
  let previousEnd = -Infinity
  for (const ramp of message.ramps) {
    if (!ramp || !Number.isFinite(ramp.start) || !Number.isFinite(ramp.end)
      || !Number.isFinite(ramp.from) || !Number.isFinite(ramp.to)
      || ramp.end < ramp.start || ramp.start < previousEnd
      || ramp.from < 0 || ramp.from > 1 || ramp.to < 0 || ramp.to > 1) return false
    previousEnd = ramp.end
  }
  return true
}

class EnvelopeLane {
  constructor(processor, slot) {
    this.processor = processor
    this.slot = slot
    this.generation = 0
    this.instanceId = 0
    this.clear()
  }

  clear() {
    this.active = false
    this.ramps = []
    this.bridge = null
    this.revision = -1
    this.appliedFrame = this.processor.nextFrame
    this.zeroAcknowledged = false
    this.endFrame = null
  }

  claim(message) {
    if (message.generation <= this.generation
      || (message.initialPlan && !validPlan(message.initialPlan))) return
    this.clear()
    this.active = true
    this.generation = message.generation
    this.instanceId = message.instanceId
    if (message.initialPlan) this.install(message.initialPlan)
  }

  matches(message) {
    return this.active && message.generation === this.generation && message.instanceId === this.instanceId
  }

  install(message) {
    if (!validPlan(message) || message.revision <= this.revision) return
    // All channels and command changes execute on the same render thread.
    // Prefixes keep already-planned ADSR samples up to the new anchor intact.
    const appliedAt = Math.max(currentFrame, this.processor.nextFrame) / sampleRate
    const previousValue = this.outputAt(appliedAt)
    const nextValue = valueAt(message.ramps, appliedAt)
    const late = message.at < appliedAt - 1 / sampleRate
    if (late && Math.abs(previousValue - nextValue) > 1e-7) {
      const end = appliedAt + LATE_BLEND_SECONDS
      this.bridge = { start: appliedAt, end, from: previousValue, to: valueAt(message.ramps, end) }
    } else if (this.bridge && message.at < this.bridge.end) {
      this.bridge = {
        start: appliedAt, end: this.bridge.end, from: previousValue,
        to: valueAt(message.ramps, this.bridge.end),
      }
    }
    this.ramps = message.ramps
    this.revision = message.revision
    this.appliedFrame = Math.max(currentFrame, this.processor.nextFrame)
    this.zeroAcknowledged = false
    const last = this.ramps[this.ramps.length - 1]
    // Preserve a late bridge endpoint even after that bridge is no longer live.
    this.endFrame = last?.to === 0
      ? Math.ceil(Math.max(last.end, this.bridge?.end ?? last.end) * sampleRate) : null
    this.reportState(null)
  }

  outputAt(time) {
    if (!this.active) return 0
    if (this.bridge && time < this.bridge.end) {
      const bridge = this.bridge
      if (time <= bridge.start) return bridge.from
      return bridge.from + (bridge.to - bridge.from) * (time - bridge.start) / (bridge.end - bridge.start)
    }
    return valueAt(this.ramps, time)
  }

  reportState(zeroFrame) {
    this.processor.port.postMessage({
      type: 'state', slot: this.slot, generation: this.generation,
      instanceId: this.instanceId, revision: this.revision,
      appliedFrame: this.appliedFrame,
      renderedThroughFrame: this.processor.nextFrame - 1,
      endFrame: this.endFrame, zeroFrame,
      readyFrame: this.processor.readyFrame,
      firstProcessFrame: this.processor.firstProcessFrame,
    })
  }

  render(output) {
    let entirelyZero = true
    for (let index = 0; index < output.length; index++) {
      output[index] = this.outputAt((currentFrame + index) / sampleRate)
      if (output[index] !== 0) entirelyZero = false
    }
    if (this.active && !this.zeroAcknowledged && this.endFrame !== null
      && currentFrame >= this.endFrame && entirelyZero) {
      this.zeroAcknowledged = true
      this.reportState(currentFrame)
    }
    if (this.bridge && this.processor.nextFrame / sampleRate >= this.bridge.end) this.bridge = null
  }
}

class EnvelopeControl extends AudioWorkletProcessor {
  constructor() {
    super()
    this.nextFrame = currentFrame
    this.readyFrame = currentFrame
    this.firstProcessFrame = null
    this.disposed = false
    this.lanes = Array.from({ length: MAX_LANES }, (_unused, slot) => new EnvelopeLane(this, slot))
    this.port.onmessage = event => {
      const message = event.data
      if (!message || this.disposed) return
      if (message.type === 'dispose') {
        this.disposed = true
        for (const lane of this.lanes) lane.clear()
        this.port.close()
        return
      }
      if (!Number.isSafeInteger(message.slot) || message.slot < 0 || message.slot >= MAX_LANES
        || !Number.isSafeInteger(message.generation) || message.generation < 1
        || !Number.isSafeInteger(message.instanceId) || message.instanceId < 1) return
      const lane = this.lanes[message.slot]
      if (message.type === 'claim') lane.claim(message)
      else if (lane.matches(message)) {
        if (message.type === 'release' || message.type === 'dispose-lane') lane.clear()
        else if (message.type === 'plan') lane.install(message)
      }
    }
    this.reportReady()
  }

  reportReady() {
    this.port.postMessage({ type: 'ready', readyFrame: this.readyFrame, firstProcessFrame: this.firstProcessFrame })
  }

  process(_inputs, outputs) {
    const channels = outputs[0]
    if (!channels?.length) return !this.disposed
    if (this.disposed) {
      for (const output of channels) output.fill(0)
      return false
    }
    const first = this.firstProcessFrame === null
    if (first) this.firstProcessFrame = currentFrame
    this.nextFrame = currentFrame + channels[0].length
    for (let slot = 0; slot < channels.length; slot++) {
      if (slot < MAX_LANES) this.lanes[slot].render(channels[slot])
      else channels[slot].fill(0)
    }
    if (first) this.reportReady()
    return true
  }
}

registerProcessor('sound-lab-envelope-v1', EnvelopeControl)
