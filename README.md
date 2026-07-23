# paperpoker

Free-play Texas Hold'em with customizable bot opponents and optional
quant/EV stats mode.

## What exists so far

- `src/deck.js` - Card + Deck (build, shuffle, draw)
- `src/handEvaluator.js` - evaluates any 5 cards into a comparable score,
  plus `bestOf7` which finds the best 5-card hand out of 7 cards (2 hole +
  5 board). This is the single most important correctness-critical piece
  of the whole engine.
- `src/showdown.js` - given multiple players' hole cards and a board,
  determines the winner(s), handling split pots on exact ties.
- `test/handEvaluator.test.js` - 8 passing tests covering hand rankings,
  the wheel straight (A-2-3-4-5) edge case, and split pots.

Run tests with:

```
npm test
```

## Next chunks, in order (don't skip ahead)

1. **Betting round engine** - a `Table` class that tracks players, stacks,
   the pot, current street (preflop/flop/turn/river), whose turn it is,
   and legal actions (fold/check/call/bet/raise) given the current bet.
   Write tests for edge cases first: all-in for less than a full call,
   side pots when multiple players go all-in for different amounts,
   what happens when everyone folds to one player pre-showdown.
2. **A single rule-based bot** ("easy" tier) that can occupy any seat -
   simple hand-strength thresholds, fixed bet sizing.
3. **A minimal playable UI** wired to the engine for one table size.
4. **Hand history logging** - log every action to a structured record as
   it happens, not after the fact.
5. Only after 1-4 are solid: medium/hard bot tiers, multi-way table
   customization, EV/equity display, export.

## Working with Claude Code

When you continue this in Claude Code Desktop, point it at this README
and this codebase first so it has context. Ask for one numbered chunk at
a time, request tests alongside any new game-logic code, and run
`npm test` after each change before moving to the next chunk.
