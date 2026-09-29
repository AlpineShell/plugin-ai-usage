# Claude Code Usage

Your Claude Code limits on Ridge: a small bar that turns white, then orange, then red as you near a limit.

![The usage breakdown on Ridge](docs/usage.png)

Hover it for every limit: the 5-hour session, the week and each model, with the percentage used and when it resets. Before your first message, the session shows as not started. When the numbers can't be fetched, the bar dims and hovering it says why.

Once a minute the plugin reads your local Claude Code login and asks Anthropic's usage endpoint for the numbers `/usage` shows. It sends nothing anywhere else, and there is nothing to set up.
