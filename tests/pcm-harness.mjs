import { mkdir, writeFile } from 'node:fs/promises'

/** Retry only unusable native captures; a failed gap-free case is final. */
export async function runPcmSuite(run, reportUrl, { beforeRetry } = {}) {
  const selected = new Map()
  const invalidCaptures = []
  const attempts = []
  let last
  let order = []
  let validFailure = false
  await mkdir(new URL('./', reportUrl), { recursive: true })
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await beforeRetry?.()
    last = await run()
    order = last.results.map(result => result.name)
    const attemptUrl = new URL(reportUrl.href.replace(/\.json$/, `-attempt${attempt}.json`))
    await writeFile(attemptUrl, JSON.stringify(last, null, 2))
    attempts.push({ attempt, report: attemptUrl.pathname.split('/').at(-1) })
    for (const result of last.results) {
      if ((result.metrics.missingFrames ?? 0) > 0) {
        invalidCaptures.push({ attempt, name: result.name, missingFrames: result.metrics.missingFrames, gaps: result.metrics.gaps ?? [] })
        continue
      }
      const failed = result.checks.some(check => !check.passed)
      if (failed || !selected.has(result.name)) selected.set(result.name, { ...result, captureAttempt: attempt })
      if (failed) validFailure = true
    }
    if (validFailure || selected.size === order.length) break
  }
  const results = order.map(name => {
    if (selected.has(name)) return selected.get(name)
    const invalid = last.results.find(result => result.name === name)
    return { ...invalid, captureAttempt: null, checks: [...invalid.checks, { description: 'native capture is complete after at most three attempts', passed: false }] }
  })
  return {
    results,
    failures: results.flatMap(result => result.checks.filter(check => !check.passed).map(check => `${result.name}: ${check.description}`)),
    captureAttempts: attempts,
    invalidCaptures,
  }
}
