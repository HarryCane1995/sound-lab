/** Native browser PCM capture for tests; no product runtime depends on it. */
export async function createPcmRecorder(context, source, { channels = 1 } = {}) {
  const name = `sound-lab-pcm-${Math.random().toString(36).slice(2)}`
  const code = `class Recorder extends AudioWorkletProcessor {
    constructor(){super();this.buffers=Array.from({length:${channels}},()=>new Float32Array(65536));this.frames=0;this.start=0;this.gaps=[];this.port.onmessage=e=>{if(e.data==='flush'){this.flush();this.port.postMessage({kind:'flushed',frame:currentFrame})}}}
    flush(){if(!this.frames)return;const channels=this.buffers.map(buffer=>buffer.slice(0,this.frames));this.port.postMessage({kind:'pcm',startFrame:this.start,gaps:this.gaps,channels},channels.map(c=>c.buffer));this.frames=0;this.gaps=[]}
    process(inputs){const input=inputs[0];const length=input[0]?.length||128;if(this.frames&&currentFrame!==this.start+this.frames){const missing=currentFrame-this.start-this.frames;if(missing<0||this.frames+missing+length>65536)this.flush();else{this.gaps.push({startFrame:this.start+this.frames,endFrame:currentFrame,frames:missing});for(const buffer of this.buffers)buffer.fill(0,this.frames,this.frames+missing);this.frames+=missing}}if(this.frames+length>65536)this.flush();if(!this.frames)this.start=currentFrame;for(let channel=0;channel<${channels};channel++){if(input[channel])this.buffers[channel].set(input[channel],this.frames);else this.buffers[channel].fill(0,this.frames,this.frames+length)}this.frames+=length;return true}
  }registerProcessor('${name}',Recorder)`
  const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
  try { await context.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
  const node = new AudioWorkletNode(context, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: channels, channelCountMode: 'explicit' })
  const silent = context.createGain()
  silent.gain.value = 0
  source.connect(node)
  node.connect(silent)
  silent.connect(context.destination)
  const chunks = []
  let resolveFlush = null
  let closed = false
  node.port.onmessage = event => {
    if (event.data.kind === 'pcm') chunks.push(event.data)
    if (event.data.kind === 'flushed') { resolveFlush?.(); resolveFlush = null }
  }
  const snapshot = () => {
    const firstFrame = chunks[0]?.startFrame ?? 0
    const last = chunks.at(-1)
    const lastFrame = last ? last.startFrame + last.channels[0].length : firstFrame
    const buffers = Array.from({ length: channels }, () => new Float32Array(lastFrame - firstFrame))
    const gaps = []
    let expectedFrame = firstFrame
    let capturedFrames = 0
    for (const chunk of chunks) {
      if (chunk.startFrame > expectedFrame) gaps.push({ startFrame: expectedFrame, endFrame: chunk.startFrame, frames: chunk.startFrame - expectedFrame })
      gaps.push(...(chunk.gaps || []))
      capturedFrames += chunk.channels[0].length - (chunk.gaps || []).reduce((sum, gap) => sum + gap.frames, 0)
      expectedFrame = chunk.startFrame + chunk.channels[0].length
    }
    for (const chunk of chunks) for (let channel = 0; channel < channels; channel++) buffers[channel].set(chunk.channels[channel], chunk.startFrame - firstFrame)
    return { sampleRate: context.sampleRate, firstFrame, lastFrame, capturedFrames, gaps, missingFrames: gaps.reduce((sum, gap) => sum + gap.frames, 0), channels: buffers, samples: buffers[0] }
  }
  const close = () => {
    if (closed) return
    closed = true
    try { source.disconnect(node) } catch { /* Source may already be disposed. */ }
    node.disconnect()
    silent.disconnect()
    node.port.close()
  }
  const flush = async () => {
    if (closed || context.state !== 'running') return
    await Promise.race([
      new Promise(resolve => { resolveFlush = resolve; node.port.postMessage('flush') }),
      new Promise(resolve => setTimeout(resolve, 250)),
    ])
  }
  // Establish the worklet clock and warm its first buffer transfer before the
  // caller sends any test stimulus. No post-stimulus gap is discarded.
  await new Promise(resolve => setTimeout(resolve, 100))
  await flush()
  chunks.length = 0
  return {
    snapshot,
    close,
    async stop() {
      await flush()
      const result = snapshot()
      close()
      return result
    },
  }
}
