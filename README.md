# bites

Have you ever stared at the Claude Code CLI while it cycles through "Beaming…", "Quantumizing…" and "Metamorphosing…"?

Now you can wait while learning something new!

## How it works

1. Instead of the "Thinking…" placeholder text, the spinner shows fun facts that Claude writes for you in the background.
2. It keeps track of what you've seen, so facts don't repeat.
3. Want to learn about a specific topic, or avoid one? Just tell Claude ("teach me about ancient Rome while I wait", "no more space facts") and it adapts.
4. At the end of each turn you'll see how much you picked up: `✻ Baked for 3m 12s · Learned 5 new things`.

No settings, no fact lists: every fact is written fresh by Claude, and nothing from your project is ever sent along.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install bites --marketplace kybercore/claude-bites
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install bites --marketplace kybercore/claude-bites
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `kybercore/claude-bites`, then Add plugin.

## Notes

- Facts are written in batches by a small background model call, only when you're running low on unseen ones.
- Your topic, avoided topics and seen facts are kept across sessions.

## License

MIT
