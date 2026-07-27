import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/sessionRegistry.js";

function fakeIo() {
  const emitted = [];
  return {
    emitted,
    to(roomId) {
      return { emit(event, payload) { emitted.push({ roomId, event, payload }); } };
    },
  };
}

function fakeSocket(id) {
  return {
    id,
    rooms: new Set(),
    emitted: [],
    join(room) { this.rooms.add(room); },
    emit(event, payload) { this.emitted.push({ event, payload }); },
  };
}

test("createRoom seats the host as player 1 and returns their code/playerId/isHost", () => {
  const registry = new SessionRegistry(fakeIo());
  const hostSocket = fakeSocket("socket-host");
  const result = registry.createRoom("session-host", hostSocket, { displayName: "Host" });

  assert.equal(result.playerId, "session-host");
  assert.equal(result.isHost, true);
  assert.equal(result.code.length, 6);

  const room = registry.getRoom(result.code);
  assert.equal(room.tableGame.players.length, 1);
  assert.equal(room.tableGame.players[0].id, "session-host");
  assert.ok(hostSocket.rooms.has("room:" + result.code));

  clearInterval(registry._sweepInterval);
});

test("joinRoom seats a second real player in the same room's TableGame, not the host", () => {
  const registry = new SessionRegistry(fakeIo());
  const hostSocket = fakeSocket("socket-host");
  const { code } = registry.createRoom("session-host", hostSocket, { displayName: "Host" });

  const guestSocket = fakeSocket("socket-guest");
  const joinResult = registry.joinRoom("session-guest", guestSocket, code, { displayName: "Guest" });

  assert.equal(joinResult.isHost, false);
  const room = registry.getRoom(code);
  assert.equal(room.tableGame.players.length, 2);
  assert.ok(room.tableGame.players.some((p) => p.id === "session-guest"));

  clearInterval(registry._sweepInterval);
});

test("joinRoom with an unknown code throws a clear error", () => {
  const registry = new SessionRegistry(fakeIo());
  assert.throws(() => registry.joinRoom("session-x", fakeSocket("s"), "ZZZZZZ", {}), /not found/i);
  clearInterval(registry._sweepInterval);
});

test("joinRoom refuses once the room is full", () => {
  const registry = new SessionRegistry(fakeIo());
  const host = fakeSocket("socket-host");
  const { code } = registry.createRoom("session-host", host, {});
  for (let i = 0; i < 8; i++) {
    registry.joinRoom(`session-${i}`, fakeSocket(`socket-${i}`), code, {});
  }
  assert.equal(registry.getRoom(code).tableGame.players.length, 9);
  assert.throws(() => registry.joinRoom("session-overflow", fakeSocket("socket-overflow"), code, {}), /full/i);
  clearInterval(registry._sweepInterval);
});

test("joinRoom refuses new (not-already-seated) players once the room is locked, but a reconnecting seated player still gets back in", () => {
  const registry = new SessionRegistry(fakeIo());
  const host = fakeSocket("socket-host");
  const { code } = registry.createRoom("session-host", host, {});
  registry.joinRoom("session-guest", fakeSocket("socket-guest-1"), code, {});

  registry.getRoom(code).locked = true;

  assert.throws(() => registry.joinRoom("session-new", fakeSocket("socket-new"), code, {}), /locked/i);
  // Already-seated guest reconnecting (e.g. a page refresh) should still work even while locked.
  assert.doesNotThrow(() => registry.joinRoom("session-guest", fakeSocket("socket-guest-2"), code, {}));

  clearInterval(registry._sweepInterval);
});

test("isRoomHost correctly distinguishes the host from any other seated player", () => {
  const registry = new SessionRegistry(fakeIo());
  const { code } = registry.createRoom("session-host", fakeSocket("socket-host"), {});
  registry.joinRoom("session-guest", fakeSocket("socket-guest"), code, {});

  assert.equal(registry.isRoomHost(code, "session-host"), true);
  assert.equal(registry.isRoomHost(code, "session-guest"), false);
  assert.equal(registry.isRoomHost("NOT-A-CODE", "session-host"), false);

  clearInterval(registry._sweepInterval);
});

test("reconnecting (same sessionId, new socket) does not create a duplicate seat", () => {
  const registry = new SessionRegistry(fakeIo());
  const { code } = registry.createRoom("session-host", fakeSocket("socket-host-1"), {});
  registry.joinRoom("session-host", fakeSocket("socket-host-2"), code, {}); // simulates a refresh

  const room = registry.getRoom(code);
  assert.equal(room.tableGame.players.length, 1, "reconnecting should not seat a second copy of the host");
});

test("stateChanged broadcasts a personalized getStateFor to every connected socket in the room, not a single shared state", () => {
  const io = fakeIo();
  const registry = new SessionRegistry(io);
  const hostSocket = fakeSocket("socket-host");
  const { code } = registry.createRoom("session-host", hostSocket, {});
  const guestSocket = fakeSocket("socket-guest");
  registry.joinRoom("session-guest", guestSocket, code, {});

  const room = registry.getRoom(code);
  room.tableGame.gameStarted = true;
  room.tableGame.startNewHand();

  const hostGameStates = io.emitted.filter((e) => e.roomId === "socket-host" && e.event === "gameState");
  const guestGameStates = io.emitted.filter((e) => e.roomId === "socket-guest" && e.event === "gameState");
  assert.ok(hostGameStates.length > 0);
  assert.ok(guestGameStates.length > 0);

  const lastHostState = hostGameStates[hostGameStates.length - 1].payload;
  const lastGuestState = guestGameStates[guestGameStates.length - 1].payload;
  assert.equal(lastHostState.viewerId, "session-host");
  assert.equal(lastGuestState.viewerId, "session-guest");

  clearInterval(registry._sweepInterval);
});

test("removeRoomSocket drops the socket from viewerBySocket but leaves the player's seat intact", () => {
  const registry = new SessionRegistry(fakeIo());
  const hostSocket = fakeSocket("socket-host");
  const { code } = registry.createRoom("session-host", hostSocket, {});
  const room = registry.getRoom(code);

  assert.equal(room.viewerBySocket.size, 1);
  registry.removeRoomSocket(code, "socket-host");
  assert.equal(room.viewerBySocket.size, 0);
  assert.equal(room.tableGame.players.length, 1, "the seat itself should persist through a disconnect");

  clearInterval(registry._sweepInterval);
});

test("removeRoomSocket schedules room cleanup once every socket has left, and reconnecting cancels it", () => {
  const registry = new SessionRegistry(fakeIo());
  const hostSocket = fakeSocket("socket-host");
  const { code } = registry.createRoom("session-host", hostSocket, {});
  const room = registry.getRoom(code);

  registry.removeRoomSocket(code, "socket-host");
  assert.ok(room.cleanupTimer, "expected a cleanup timer once the room is empty");

  registry.joinRoom("session-host", fakeSocket("socket-host-2"), code, {});
  assert.equal(room.cleanupTimer, null, "reconnecting should cancel the pending cleanup");

  clearInterval(registry._sweepInterval);
});

test("disposeRoom clears timers, disposes the TableGame, and removes the room from the registry", () => {
  const registry = new SessionRegistry(fakeIo());
  const { code } = registry.createRoom("session-host", fakeSocket("socket-host"), {});
  const room = registry.getRoom(code);
  room.tableGame.gameStarted = true;
  room.tableGame.dealerIndex = 0;

  registry.disposeRoom(code);
  assert.equal(registry.getRoom(code), null);

  clearInterval(registry._sweepInterval);
});
