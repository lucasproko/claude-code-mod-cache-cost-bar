# usage-band-plus

Context, prompt cache and cost for Claude Code.

<img width="1648" height="272" alt="Screeshot-2026-10-16 at 19 05 22@2x" src="https://github.com/user-attachments/assets/40dbb58d-5741-429e-8f62-c4d5b3a75795" />


Three numbers in the prompt footer, beside the permission mode and the model: `34% · ~$13.52 · 59m`.

| Number | `/usage-band` explains |
|---|---|
| `34%` context | Tokens used of the auto-compact window (as the app's Context panel counts), and when Handoff is offered. Amber from 50%, red from 80%. |
| `~$13.52` cost | Session cost at API prices and the last turn's cost. `~` means an estimate on a subscription. |
| `59m` cache | When the warm cache expires (clock time), the TTL, and the last request's hit rate. `≈` means the TTL is assumed until the turn ends; `cold` means expired or a new model. |

Type `/usage-band` for what each number means, with current values. The desktop footer draws text only (no Svg, no hover), so it cannot carry tooltips.

Five minutes before a warm cache expires (contexts of 20k tokens or more), you get a toast and a macOS notification, and a row above the prompt offers **Compact** or **Let it expire**. On desktop, `$.ui.notify` has no channel, so the notification goes through [terminal-notifier](https://github.com/julienXX/terminal-notifier) when it is installed. A click on it opens the session that sent it. Without terminal-notifier, the notification goes through `osascript`, and macOS credits it to Script Editor, so a click opens Script Editor.

Handoff appears above the prompt when context passes 80%. `/handoff` works at any time: it writes a handoff note, runs `/clear`, and puts the note (and your draft) in the prompt box.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install usage-band-plus --marketplace lucasproko/claude-code-mod-cache-cost-bar
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```bash
claude plugin install usage-band-plus --marketplace lucasproko/claude-code-mod-cache-cost-bar
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `lucasproko/claude-code-mod-cache-cost-bar`, then Add plugin.

On macOS, also install terminal-notifier, so a click on the cache notification opens its session:

```bash
brew install terminal-notifier
```

The first notification asks to allow notifications from terminal-notifier. Set its alert style to Banners or Alerts in System Settings > Notifications.

Start a new session afterwards. Settings are in the config menu under usage-band-plus.

## Update

```bash
claude plugin marketplace update lucasproko-plugins
claude plugin update usage-band-plus@lucasproko-plugins
```

## What changed from usage-band

- Cache hit rate and timing come from the engine's `turn.step` usage, not a shell read of the transcript. Subagent requests are ignored.
- Usage is pushed by `session.measure`. A 30s timer moves the reset countdowns and picks up `/model` switches.
- "cold, new model" compares canonical model ids, so a `[1m]` session no longer shows it by mistake.
- Timers are cancelled with `Timer.cancel()`. On this build's API, `$.clock.every` returns a Timer object; the original calls it as a function, which would throw on a second `session.start`.
- Handoff uses `$.model.fork` by default (full cached transcript, the session's model) and falls back to Haiku on an API error. The `haiku` setting is cheaper and now includes tool calls and file paths.
- After `/clear` (typed or from Handoff), the cache segment and last-turn cost reset.
- Handoff keeps your prompt draft and asks for confirmation.
- The readout moved to the prompt footer as three numbers; `/usage-band` explains them.
- Five minutes before a warm cache expires: a toast, a macOS notification, and Compact or Let it expire.
- The Handoff button is highlighted, and a toast shows once, when context passes 80%.

## Settings

All in the config menu (`userConfig`): placement (`footer` or `band`), context thresholds, whether cache and cost show, cache TTL (`auto`, `1h`, `5m`), the expiry warning in minutes, the handoff writer (`fork` or `haiku`), the context % that highlights Handoff, and handoff confirmation.

`auto` TTL reads the transcript once per turn with `sh`, so it is macOS and Linux only. On Windows, set `1h` or `5m`.

## Develop

```bash
claude plugin validate .
claude plugin test .
```
