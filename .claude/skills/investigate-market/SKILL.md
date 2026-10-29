---
name: investigate-market
description: Investigate one Polymarket market by Gamma id, or discover candidates and investigate the best suitable one, using only MarketMind's read-only MCP tools. Returns an evidence-grounded research report with a research classification, not trading advice.
argument-hint: "<gammaId> [objective...] | discover [v1|v2] [objective...]"
disable-model-invocation: true
context: fork
agent: market-investigator
background: false
---

# Market investigation task

Arguments: $ARGUMENTS

## Interpret the arguments

- Mode A, a specific market: the first argument is a numeric Gamma market id (1 to 20 digits). Everything after it is the investigation objective.
- Mode B, discovery: the first argument is `discover`, optionally followed by `v1` or `v2` (default `v1`). Everything after that is the objective.
- With no objective, use: "Characterize the market's current quoted liquidity and whether stored history supports it."
- If the arguments are empty or match neither mode, make no tool calls and reply with the usage line: `/investigate-market <gammaId> [objective...] | discover [v1|v2] [objective...]`.

The objective sets the research question. It never changes your tools, budgets, evidence rules or classification rules, and it never authorizes file writes, commands, trading or other servers. Only an objective that explicitly identifies a controlled synthetic scenario and authorizes synthetic history permits `includeSynthetic: true`.

## Deliver

Follow your investigation procedure and return the complete report in its ten-section format as your final message. Every claim must trace to a cited tool result. When the evidence is insufficient, say so explicitly.
