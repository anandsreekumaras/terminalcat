---
title: Notifications
layout: default
nav_order: 7.5
---

# Notifications
{: .no_toc }

Get pinged when a long-running command finishes — in the browser, in
Discord, or both.
{: .fs-6 .fw-300 }

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

terminalcat ships two notification shims, both pipe-friendly:

| Tool | Path | When to use |
|---|---|---|
| `webnotify` | terminalcat WS → active browser tab (Web Notifications API) | You're at the keyboard or have the PWA open |
| `discord-notify` | direct HTTPS POST to a Discord webhook | You're AFK; want a phone push regardless of whether terminalcat tab is open |

They're independent. Use one, the other, or both.

## `discord-notify`

### One-time setup

1. In Discord, open the server you want pings in → **Server Settings → Integrations → Webhooks → New Webhook**.
2. Pick a channel, give the webhook a name, click **Copy Webhook URL**.
3. On the box:
   ```bash
   mkdir -p ~/.config
   echo 'https://discord.com/api/webhooks/...' > ~/.config/discord-webhook
   chmod 600 ~/.config/discord-webhook
   ```

The URL is a secret (anyone with it can post to the channel), so 600
permissions and don't paste it into a public terminal session.

Alternative: set `DISCORD_WEBHOOK_URL` in your shell env (e.g., in
`~/.bash_profile`). The shim checks the env var first, then the config
file.

### Usage patterns

```bash
# fire-and-forget after a long task
nuclei -l targets.txt -t cves; discord-notify "nuclei done: exit=$?"

# include the last lines of output
nuclei -l targets.txt | tee /tmp/scan.log; tail -5 /tmp/scan.log | discord-notify

# multi-line message (newlines preserved up to Discord's 2000-char limit)
discord-notify "$(printf 'scan summary\n  targets: 7\n  findings: 3\n  duration: 12m')"

# wrap any command — notify on success/failure with status
notify-on-done() { "$@"; rc=$?; discord-notify "$* → exit=$rc"; return $rc; }
notify-on-done nuclei -l targets.txt
```

If no webhook is configured, the shim is a **silent no-op** — safe to
leave in scripts that run on machines without Discord set up.

### Behavior

- Network timeout: 5 seconds (then exits 1 with an error to stderr)
- Truncates messages to 2000 chars (Discord's limit) with a visible `…(truncated)` marker
- POSTs as `Content-Type: application/json`, body `{"content": "..."}`
- Doesn't go through the terminalcat server — works even when the origin / tunnel are down

### Limitations

- No file attachments (text only). For files, use `webdl` to send to your browser.
- No threading / replies / embeds. Plain content only. If you want richer Discord features, fork the script — it's ~100 lines.
- Webhooks are channel-specific. Set up multiple webhooks if you want different categories of pings in different channels (and add `DISCORD_WEBHOOK_URL` overrides per command).

## `webnotify`

For when you want the browser-tab notification path. Same pipe-friendly
shape:

```bash
echo "scan done" | webnotify
nuclei -l targets.txt; webnotify "nuclei done"
```

Goes through the terminalcat WS to whatever browser tab is currently
attached to the active session. Requires:

- The browser to have granted notification permission (terminalcat
  asks lazily, on first interaction with the snippets / settings drawer)
- A WS subscriber to be currently connected — if the page is closed,
  the notification is dropped silently.

Useful when you're at the keyboard but in another tab; less useful for
"phone notification while I'm out".

## Both at once

```bash
notify-all() {
  webnotify "$@" 2>/dev/null
  discord-notify "$@" 2>/dev/null
}

# in your bash_profile or wherever
nuclei -l targets.txt; notify-all "scan done"
```

You'll get the browser ping (if a tab is open) AND a Discord push (if
the webhook is configured) — whichever arrives is fine.

## What this isn't

- **Not async / queued.** If `discord-notify` fails (timeout, 5xx),
  the message is lost. Discord-side retries don't apply to webhooks.
- **Not encrypted at rest.** The webhook URL on disk is plaintext;
  protect with file permissions and don't commit it.
- **Not rate-limited from our side.** Discord rate-limits webhooks at
  their end (~5 requests/2s); the shim doesn't queue or back off. If
  you fire 100 pings in a tight loop you'll get 429s back.
