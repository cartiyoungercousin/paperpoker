// Visually-unambiguous alphabet: no 0/O, 1/I/L - a code read aloud or typed
// from memory shouldn't be able to hit a "which letter did they mean" wall.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

// Retries a handful of times on a collision against the registry's existing
// codes. At this code space (32^6, ~1.07 billion) a collision is already
// vanishingly unlikely at any realistic scale - this is cheap defense in
// depth, not load-bearing uniqueness logic. Returns null if every attempt
// collided, which the caller should treat as a hard failure.
function generateUniqueRoomCode(existingCodes, maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateRoomCode();
    if (!existingCodes.has(code)) return code;
  }
  return null;
}

export { generateRoomCode, generateUniqueRoomCode, CODE_ALPHABET, CODE_LENGTH };
