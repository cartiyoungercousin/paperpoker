import test from 'node:test';
import assert from 'node:assert/strict';
import { TableGame } from '../server.js';

test('updateSettings resets state without starting a hand automatically', () => {
  const game = new TableGame({ numPlayers: 3, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  game.updateSettings({ numPlayers: 3, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  assert.equal(game.gameStarted, false);
  assert.equal(game.handCount, 0);
  assert.equal(game.hand, null);
  assert.equal(game.players[0].seat, 0);
  const marcusSeat = game.players.find(p => p.id === 'Marcus')?.seat;
  assert.ok(marcusSeat === undefined || marcusSeat > 0);
});

test('new tables assign distinct color classes to players', () => {
  const game = new TableGame({ numPlayers: 4, startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  const colors = game.players.map((player) => player.colorClass);

  assert.equal(colors[0], 'color-0');
  assert.ok(colors.slice(1).every((color) => color && color.startsWith('color-')));
  assert.notEqual(colors[1], colors[2]);
});
