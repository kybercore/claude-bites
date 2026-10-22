import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fact } from '../types'

const current = atom({ plugin: 'bites', key: 'current' } as const, null)
const learned = atom({ plugin: 'bites', key: 'learned' } as const, {})

// Batches are rare, so the writer can be a model that knows its facts well.
const MODEL = 'claude-sonnet-5-5'
const TOOL = 'set_learning_topic'
const ROTATE_MS = 12_000
const TICK_MS = 1_000
// A fact counts as learned once it has been on screen this long.
const READ_MS = 4_000
// The most a batch may hold; the writer gives fewer rather than pad it.
const BATCH = 25
const POOL_MAX = 400
// Low, as a batch on a narrow topic may hold only a handful.
const REFILL_BELOW = 4
// The longest fact shown; the writer is told the same limit.
const MAX_CHARS = 110
// How many earlier facts the writer is told not to repeat.
const REPEAT_WINDOW = 80
// Sessions in which the hint may show, until a topic has been set.
const HINT_SESSIONS = 5
const HINT_CHANCE = 0.25

const HINT = 'Curious about something? Tell Claude what you’d like to learn while you wait.'
// Shown while the first batch of a topic is still being written.
const WRITING = 'Thinking up new fun facts…'

const WRITER_SYSTEM =
  'You write fun facts for someone glancing at a progress line while they wait. ' +
  'Every fact must make a curious person say "wait, really?": a surprising twist, an odd connection, ' +
  'a counterintuitive number, a strange origin. Skip anything that reads like a textbook or an encyclopedia entry; ' +
  'a true but dull fact is a failure. ' +
  `Keep each one short, ideally under 90 characters and never over ${MAX_CHARS}: one punchy sentence. ` +
  'Cut every word that does not add to the surprise, and say each thing in its shortest recognizable form. ' +
  'Only well-established facts you are sure of; no myths, no hedging, no vague claims. ' +
  'Never pad: a short list of great facts beats a long one with filler.'

const SYSTEM_SECTION = {
  id: 'bites:topic',
  scope: 'session',
  text:
    'While the user waits on you, a mod shows short fun facts in the spinner. ' +
    `When the user says what they would like to learn about while waiting, asks for a different topic ` +
    `or for general facts again, or wants to avoid a topic (or allow one again), call mcp__bites__${TOOL}, ` +
    'then carry on with what they asked. ' +
    'Only call it for an explicit wish; never infer a topic from their project or files.',
} as const

// Store keys, kept across sessions.
const POOL_KEY = 'pool' // { version, topic, facts }
// Bumped when the writing rules change, so older batches are written again.
const POOL_VERSION = 3
const SEEN_KEY = 'seen'
const TOPIC_KEY = 'topic'
const AVOID_KEY = 'avoid'
const HINTS_KEY = 'hintSessions'
const AVOID_MAX = 30

// What a batch is written for: the topic and the topics to stay away from.
type Wish = { topic: string; avoid: string[] }
type Pool = { version: number; wish: string; facts: Fact[] }

// When the batch being written started; a write that never settles stops counting after WRITE_STALE_MS.
let writingSince: number | null = null
const WRITE_STALE_MS = 90_000
const LAST_WRITE_KEY = 'lastWrite'
let rotation: { cancel: () => void } | null = null
let shown: { text: Fact; at: number } | null = null
let learnedThisTurn = 0
let mayHint = false

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

async function topicOf($: EngineInterface): Promise<string> {
  const t = await $.store.get(TOPIC_KEY)
  return typeof t === 'string' ? t : ''
}

async function wishOf($: EngineInterface): Promise<Wish> {
  return { topic: await topicOf($), avoid: asStrings(await $.store.get(AVOID_KEY)) }
}

// A batch belongs to the wish it was written for; any change to it starts a new one.
const keyOf = (w: Wish) => JSON.stringify([w.topic, [...w.avoid].sort()])

async function poolOf($: EngineInterface): Promise<Pool> {
  const p = (await $.store.get(POOL_KEY)) as Partial<Pool> | undefined
  const isCurrent = p?.version === POOL_VERSION
  return {
    version: POOL_VERSION,
    wish: typeof p?.wish === 'string' ? p.wish : '',
    // Facts kept from before a lower limit are skipped too.
    facts: isCurrent ? asStrings(p?.facts).filter(f => f.length <= MAX_CHARS) : [],
  }
}

const sameTopic = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

async function unseen($: EngineInterface, facts: Fact[]): Promise<Fact[]> {
  const seen = new Set(asStrings(await $.store.get(SEEN_KEY)))
  return facts.filter(f => !seen.has(f))
}

// Picks an unseen fact for the current wish; null until Claude has written some.
async function pick($: EngineInterface): Promise<Fact | null> {
  const [wish, pool] = await Promise.all([wishOf($), poolOf($)])
  if (pool.wish !== keyOf(wish) || pool.facts.length === 0) return null

  let fresh = await unseen($, pool.facts)
  let seen = asStrings(await $.store.get(SEEN_KEY))
  if (fresh.length === 0) {
    seen = seen.filter(f => !pool.facts.includes(f))
    fresh = pool.facts
  }
  const fact = fresh[Math.floor(Math.random() * fresh.length)]!
  await $.store.set(SEEN_KEY, [...seen, fact].slice(-POOL_MAX * 2))
  return fact
}

// Asks Claude for a batch of facts for the current wish when few unseen ones are left.
async function refill($: EngineInterface) {
  const startedAt = await $.clock.now()
  if (writingSince !== null && startedAt - writingSince < WRITE_STALE_MS) return
  writingSince = startedAt
  // Kept so a batch that never shows up can be traced afterwards.
  const record = (outcome: Record<string, unknown>) =>
    $.store.set(LAST_WRITE_KEY, { at: new Date(startedAt).toISOString(), ...outcome })
  try {
    const wish = await wishOf($)
    const { topic, avoid: avoided } = wish
    const pool = await poolOf($)
    const facts = pool.wish === keyOf(wish) ? pool.facts : []
    if ((await unseen($, facts)).length >= REFILL_BELOW) return

    const today = new Date(await $.clock.now()).toDateString()
    const about = topic
      ? `about: ${topic}. Each should teach something real, told through its most surprising angle. ` +
        `When the topic itself runs thin, wander to its neighbors (its history, the people and places around it, ` +
        `related things and ideas), as long as the link to ${topic} stays clear.`
      : `across science, history, nature, language, space and computing. ` +
        `A few may tie in with today's date (${today}) or the season, where that fits naturally.`
    const stayAway = avoided.length
      ? `\nThe reader asked for nothing about these topics, not even in passing: ${avoided.join('; ')}.`
      : ''
    const avoid = facts.slice(-REPEAT_WINDOW).map(f => `- ${f}`).join('\n')

    const r = await $.model.complete({
      model: MODEL,
      maxTokens: 2500,
      timeoutMs: 60_000,
      system: WRITER_SYSTEM,
      prompt:
        `Write up to ${BATCH} fun facts ${about}${stayAway}\n` +
        'Stop when the good ones run out, even after a few.\n' +
        'One per line, no numbering, no bullets, nothing else.' +
        (avoid ? `\nDo not repeat any of these:\n${avoid}` : ''),
    })
    if (!r.isAnswered) {
      await record({ wish: keyOf(wish), outcome: 'unanswered', ...r })
      return
    }
    // The wish may have changed while Claude was writing.
    if (keyOf(await wishOf($)) !== keyOf(wish)) {
      await record({ wish: keyOf(wish), outcome: 'outdated' })
      return
    }

    const fresh = r.text
      .split('\n')
      .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter(l => l.length > 10 && l.length <= MAX_CHARS)
      // A reply cut short leaves a half sentence as its last line.
      .filter(l => /[.!?…]["'”’)]?$/.test(l))
    const merged = [...new Set([...facts, ...fresh])].slice(-POOL_MAX)
    await $.store.set(POOL_KEY, { version: POOL_VERSION, wish: keyOf(wish), facts: merged } satisfies Pool)
    await record({ wish: keyOf(wish), outcome: 'written', count: fresh.length })
  } catch (err) {
    await record({ outcome: 'failed', error: String(err).slice(0, 300) })
  } finally {
    writingSince = null
  }
}

// Counts the fact on screen if it stayed long enough to be read.
async function settle($: EngineInterface) {
  if (shown && (await $.clock.now()) - shown.at >= READ_MS) learnedThisTurn += 1
  shown = null
}

async function show($: EngineInterface) {
  await settle($)

  if (mayHint && Math.random() < HINT_CHANCE) {
    mayHint = false
    await update($, current, () => ({ text: HINT, isFact: false }))
    return
  }

  const fact = await pick($)
  if (fact === null) {
    await update($, current, () => ({ text: WRITING, isFact: false }))
    // On a timer of its own, so the writing outlives this dispatch.
    $.clock.after(1, () => void refill($))
    return
  }
  shown = { text: fact, at: await $.clock.now() }
  await update($, current, () => ({ text: fact, isFact: true }))
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  if (h > 0) return `${h}h ${m}m ${rest}s`
  if (m > 0) return `${m}m ${rest}s`
  return `${rest}s`
}

export const register: Register = on => {
  const stopRotation = () => {
    rotation?.cancel()
    rotation = null
  }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description:
        'Steers the fun facts shown while the user waits: what they are about, and topics to stay away from. ' +
        'Pass only what the user asked to change; what is left out stays as it is. ' +
        'The result says the settings now in force.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'What to learn about, in a few words (e.g. "Japanese grammar"); empty for general facts.',
          },
          avoid: {
            type: 'array',
            items: { type: 'string' },
            description: 'Topics to stop showing facts about, in a few words each (e.g. "space").',
          },
          allow: {
            type: 'array',
            items: { type: 'string' },
            description: 'Topics avoided earlier that may come back.',
          },
        },
      },
      isDeferred: false,
    })

    if (!(await topicOf($))) {
      const sessions = Number((await $.store.get(HINTS_KEY)) ?? 0)
      mayHint = sessions < HINT_SESSIONS
      if (mayHint) await $.store.set(HINTS_KEY, sessions + 1)
    }

    // Detached so the session isn't held up waiting on the model.
    $.clock.after(1, () => void refill($))
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    return { sections: [...sections, SYSTEM_SECTION] }
  })

  on('tool.call', { tool: `mcp__bites__${TOOL}` }, async ($, e) => {
    const input = e as { topic?: unknown; avoid?: unknown; allow?: unknown }
    const clean = (v: unknown) => asStrings(v).map(t => t.trim().slice(0, 100)).filter(Boolean)

    if (typeof input.topic === 'string') {
      await $.store.set(TOPIC_KEY, input.topic.trim().slice(0, 200))
    }
    const allow = clean(input.allow)
    let avoid = asStrings(await $.store.get(AVOID_KEY)).filter(a => !allow.some(b => sameTopic(a, b)))
    for (const t of clean(input.avoid)) {
      if (!avoid.some(a => sameTopic(a, t))) avoid.push(t)
    }
    avoid = avoid.slice(-AVOID_MAX)
    await $.store.set(AVOID_KEY, avoid)

    // Steering the facts once means the hint has done its job.
    await $.store.set(HINTS_KEY, HINT_SESSIONS)
    mayHint = false
    $.clock.after(1, () => void refill($))

    const topic = await topicOf($)
    return {
      result:
        (topic ? `Fun facts are now about ${topic}.` : 'Fun facts are on general topics.') +
        (avoid.length ? ` Avoiding: ${avoid.join(', ')}.` : ' Nothing is avoided.') +
        ' New facts appear from the next batch on.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    learnedThisTurn = 0
    shown = null
    await show($)

    stopRotation()
    // Ticks each second: while facts are still being written it looks again for one,
    // otherwise it moves on once a fact has had its time on screen.
    let since = await $.clock.now()
    rotation = $.clock.every(TICK_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        const isWaiting = (await read($, current))?.text === WRITING
        if (!isWaiting && now - since < ROTATE_MS) return
        since = now
        await show($)
      })()
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Subagents finish turns of their own; only the main loop's ends the wait.
    if (e.agentId !== undefined) return next(e)

    stopRotation()
    await settle($)
    const count = learnedThisTurn
    if (count > 0) {
      await update($, learned, m => ({ ...m, [String(e.durationMs)]: count }))
    }
    await update($, current, () => null)

    $.clock.after(1, () => void refill($))
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const now = await read($, current)

    // Leave the engine's own messages (compacting, retrying, ...) alone.
    if (now === null || e.props.message !== null) return next(e)

    return next({ ...e, props: { ...e.props, message: `💡 ${now.text}`, suffix: '' } })
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const counts = await read($, learned)
    // The row's duration and turn.complete's may differ by a rounding step.
    const key = Object.keys(counts).find(k => Math.abs(Number(k) - e.props.durationMs) < 1000)
    const count = key === undefined ? 0 : counts[key]!

    if (count === 0 || e.props.waitingFor !== undefined) return next(e)

    const { Text } = $.ui.resolve(e)
    return (
      <Text dimColor>
        ✻ {e.props.word} for {formatDuration(e.props.durationMs)} · Learned {count} new{' '}
        {count === 1 ? 'thing' : 'things'}
      </Text>
    )
  })
}
