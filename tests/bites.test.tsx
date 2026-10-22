import { expect, mock, test } from 'claude-code/testing'

const MUESLI = [
  'Muesli was devised around 1900 by Swiss doctor Maximilian Bircher-Benner.',
  'Müesli is Swiss German for a little mush.',
]

const USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

const SPINNER = {
  plugin: 'bites',
  component: 'Spinner',
  requestId: 'main',
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
} as const

test('a topic set through Claude fills the spinner and the turn line', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22) })
  mock.store(on, { hintSessions: 99 })

  const prompts: string[] = []
  on('model.complete', (_, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: MUESLI.join('\n'), usage: USAGE } }
  })
  // Stands for the engine's drawing: shows the props it was handed.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{JSON.stringify(e.props)}</Text>
  })
  on('tool.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => e)
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10)

  const set = await $.tool.call({ tool: 'mcp__bites__set_learning_topic', topic: 'muesli' })
  expect(String(set.result)).toMatch(/muesli/)
  await clock.advance(10)
  expect(prompts.at(-1)).toMatch(/about: muesli/)

  await $.prompt.submit({ text: 'do something long' })
  const spinner = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const shown = await spinner.find({ type: 'Text', text: /💡/ })
  expect(shown?.text).toMatch(/Bircher-Benner|little mush/)
  await spinner.unmount()

  // Two facts, each on screen past the read threshold.
  await clock.advance(12_000)
  await clock.advance(6_000)
  await $.turn.complete({ answer: '', durationMs: 18_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const line = await $.ui.mount({
    plugin: 'bites',
    component: 'TurnDuration',
    requestId: 'm1',
    surface: 'terminal',
    props: { word: 'Baked', durationMs: 18_000 },
  })
  const text = await line.find({ type: 'Text', text: /Learned/ })
  expect(text?.text).toBe('✻ Baked for 18s · Learned 2 new things')
  await line.unmount()
})

test('the spinner says facts are being written until the first batch lands', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { hintSessions: 99 })

  // The model answers only once the clock has moved 5 seconds on.
  on('model.complete', async () => {
    await clock.sleep(5_000)
    return { value: { isAnswered: true, text: MUESLI.join('\n'), usage: USAGE } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{JSON.stringify(e.props)}</Text>
  })
  on('tool.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => e)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'go' })

  const spinner = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect((await spinner.find({ type: 'Text', text: /💡/ }))?.text).toMatch(/Thinking up new fun facts/)

  // The batch lands well before the 12 s rotation, and shows within a tick.
  await clock.advance(6_000)
  expect((await spinner.find({ type: 'Text', text: /💡/ }))?.text).toMatch(/Bircher-Benner|little mush/)
  await spinner.unmount()
})

test('avoided topics stay out of the batches, and can come back', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { hintSessions: 99, topic: 'muesli' })

  const prompts: string[] = []
  on('model.complete', (_, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: MUESLI.join('\n'), usage: USAGE } }
  })
  on('tool.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10)

  const TOOL = 'mcp__bites__set_learning_topic'
  const avoided = await $.tool.call({ tool: TOOL, avoid: ['oats', 'Switzerland'] })
  // The topic, left out, stays.
  expect(String(avoided.result)).toBe(
    'Fun facts are now about muesli. Avoiding: oats, Switzerland. New facts appear from the next batch on.',
  )
  await clock.advance(10)
  expect(prompts.at(-1)).toMatch(/about: muesli/)
  expect(prompts.at(-1)).toMatch(/nothing about these topics, not even in passing: oats; Switzerland/)

  const allowed = await $.tool.call({ tool: TOOL, allow: ['switzerland'], avoid: ['OATS'] })
  expect(String(allowed.result)).toMatch(/Avoiding: oats\./)
  await clock.advance(10)
  expect(prompts.at(-1)).not.toMatch(/Switzerland/)
})
