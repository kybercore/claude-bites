export type Fact = string

declare module 'claude-code' {
  interface PluginState {
    'bites': {
      // What the spinner shows right now: a fact, or a line of the mod's own.
      current: { text: Fact; isFact: boolean } | null
      // Facts learned per finished turn, keyed by the turn's duration in ms.
      learned: Record<string, number>
    }
  }
}
