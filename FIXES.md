# Critical Fixes Required

## 1. Turn Order Bug (James going twice)
The history log shows:
- James checks
- Isabella bets
- James calls

This is CORRECT Texas Hold'em - James checked on flop then called on turn. But we need to add street markers so user can see this.

## 2. Action popup positioning
Popups are drifting down screen. Fix: keep them at fixed position.

## 3. Font size setting
User asked to remove it - it's not working and not important.

## 4. Left panel scroll
Make history list independently scrollable without page scroll.

ACTION ITEMS:
- [ ] Add street markers to hand history (--- FLOP ---, --- TURN ---, etc)
- [ ] Fix action-popup area to use fixed positioning with transform
- [ ] Remove font size control from settings modal
- [ ] Verify left panel has overflow-y: auto
- [ ] Ensure action bar shows only during user's turn