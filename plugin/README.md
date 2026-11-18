# Hobbyist agent plugin

Skills and the local `hobby mcp` server for a self-hosted Hobbyist box.

Install in Claude Code:

```
/plugin marketplace add uziiuzair/hobbyist
/plugin install hobbyist@hobbyist
```

Install the skills alone in another agent:

```sh
npx skills add uziiuzair/hobbyist
```

`hobby` must be on the `PATH` of the box the agent runs on. Full guide:
https://hobbyist.sh/docs/guides/agent-plugin/

- `.claude-plugin/plugin.json`: the Claude Code manifest. The repo root's
  `.claude-plugin/marketplace.json` lists this directory.
- `.mcp.json`: starts `hobby mcp` over stdio.
- `plugin.json` and `mcp.json`: the same plugin and server in the
  agent-plugins.org format, for clients that read that instead.
- `skills/<name>/SKILL.md`: one skill each. `site/scripts/check-plugin-skills.mjs`
  checks them against the CLI.
