# AI Usage

Your Claude, Antigravity, and OpenCode limits on Ridge: one pill with a configurable icon and a live usage bar that turns amber and red as you near a limit.

![The usage breakdown on Ridge](docs/usage.png)

Hover or click the pill for the breakdown of every provider you have turned on in Settings, with each window's percentage used and reset countdown.

## Providers

Turn each provider on or off in the **Providers** list in **Settings** > **AI Usage**. OpenCode gets a **Set up** button there for its API key, and a cog to change the key once one is saved.

- **Claude**: reads your local Claude Code login (`~/.claude/.credentials.json`) and checks Anthropic's usage endpoint.
- **Antigravity**: reads the Antigravity CLI sign-in from Windows Credential Manager and shows your plan's two quota pools: Gemini, and Claude & GPT-OSS, which share one pool. The sign-in lasts an hour and Antigravity renews it while you use it; when it has lapsed, the plugin keeps showing the last numbers it read.
- **OpenCode**: checks your OpenCode Go usage (5-hour, weekly and monthly windows). It needs a personal API key from the OpenCode console, not a service account key, since Go limits belong to a member. The key is read from `~/.local/share/opencode/auth.json`, `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY`, or the key saved on the plugin's Settings page.

## Topbar pill

Customize the pill in **Settings** > **AI Usage**:

- **Topbar icon**: Clawd, Claude, Antigravity, OpenCode, Active provider, or None.
- **Topbar bar**: show the highest usage across enabled providers, or pin the bar to one provider.