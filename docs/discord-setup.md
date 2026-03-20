# Discord Integration

Connect PipelineForge to Discord so agents can post updates to forum threads and you can respond to questions and approval gates directly from Discord.

## How it works

When Discord is enabled, PipelineForge creates a **forum thread** per pipeline run. Agents post status updates, questions, and gate approvals to the thread. You can reply from Discord or the CLI — whichever responds first wins.

```
Pipeline starts
    |
    v
Forum thread created: "PipelineForge: Add rate limiting (a1b2c3d4)"
    |
    +-- Agent posts: "project-init complete"
    +-- Agent posts: "assign-tickets complete — 3 tickets created"
    +-- Agent asks:  "Which database should I use for rate limit counters?"
    |                 ^^ You reply in Discord or CLI
    +-- Gate:        "staff-review awaiting approval"
    |                 ^^ Reply "approve" or "reject [reason]"
    +-- Agent posts: "Pipeline COMPLETED"
```

## Prerequisites

| Requirement | How to verify |
|-------------|---------------|
| **OpenClaw CLI** | `openclaw --version` |
| **OpenClaw gateway running** | `openclaw health` |
| **Discord bot created** | See below |

## 1. Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application**, name it (e.g., "PipelineForge")
3. Go to **Bot** tab, click **Reset Token**, copy the token
4. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** (required — the bot needs to read replies)
   - **Server Members Intent** (optional)
5. Go to **OAuth2 > URL Generator**:
   - Scopes: `bot`
   - Bot Permissions:
     - Send Messages
     - Send Messages in Threads
     - Create Public Threads
     - Read Message History
     - Add Reactions
6. Copy the generated URL and open it to invite the bot to your server

## 2. Set the bot token

Export the token as an environment variable. PipelineForge reads `DISCORD_BOT_TOKEN` to register the Discord channel with OpenClaw automatically.

```bash
export DISCORD_BOT_TOKEN="your-bot-token-here"
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`) so it persists across sessions.

Alternatively, register manually:

```bash
openclaw channels add --channel discord --token "$DISCORD_BOT_TOKEN"
```

## 3. Get your forum channel ID

PipelineForge creates threads inside a Discord **forum channel**. To get the channel ID:

1. Enable Developer Mode in Discord: **Settings > App Settings > Advanced > Developer Mode**
2. Right-click the forum channel > **Copy Channel ID**

## 4. Verify the connection

```bash
# Restart gateway to pick up the new channel
openclaw gateway --force

# Check channel status
openclaw channels status --probe

# Send a test message
openclaw message send --channel discord --target channel:<CHANNEL_ID> -m "Hello from PipelineForge" --json
```

## 5. Run a pipeline with Discord

### Interactive (auto command)

```bash
pipelineforge auto
```

When prompted "Enable Discord notifications?", answer **yes** and provide the forum channel ID.

### Manual

```bash
pipelineforge run \
  --feature "Add rate limiting to API" \
  --proxy \
  --discord \
  --discord-channel <FORUM_CHANNEL_ID> \
  --repo-dir /path/to/repo \
  --notes-dir /path/to/notes
```

## Responding to agents

### Questions

When an agent asks a question, you'll see it in both the terminal and Discord:

```
Discord:  "Which database should I use for rate limit counters?"
          Reply with your answer.

CLI:      ╔══ Agent Question ════════════════════════════════════╗
          ║ Which database should I use for rate limit counters? ║
          ╚════════════════════════════════════════════════════════╝
          Your answer: _
```

Reply from **either** the CLI or Discord — the first response wins.

### Approval gates

Gates show up with action hints:

```
Discord:  "Human gate: staff-review awaiting approval"
          Reply `approve` or `reject [reason]`.
```

Recognized approval words: `approve`, `approved`, `yes`, `lgtm`, `looks good`, `ship it`
Recognized rejection words: `reject`, `rejected`, `no`, `nack`

## Environment variables

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Discord bot token — auto-registers with OpenClaw on first run |

## Troubleshooting

### "Unknown channel discord"

The Discord channel isn't registered with OpenClaw. Register it:

```bash
openclaw channels add --channel discord --token "$DISCORD_BOT_TOKEN"
openclaw gateway --force  # restart to pick up changes
```

### Bot doesn't respond to messages

Check that **Message Content Intent** is enabled in the Discord Developer Portal under Bot > Privileged Gateway Intents.

### Thread not created

Verify the forum channel ID is correct and the bot has permission to create threads in that channel:

```bash
openclaw channels capabilities --channel discord --target channel:<CHANNEL_ID> --json
```

### Messages not appearing

Check the gateway logs:

```bash
openclaw channels logs --channel discord
```

### Poll timeout waiting for response

The default poll timeout is 5 minutes. If you need more time, the pipeline will continue after the timeout with the node marked as failed. You can resume later:

```bash
pipelineforge resume --id <pipeline-id>
```
