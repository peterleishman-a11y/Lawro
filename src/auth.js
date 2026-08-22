/**
 * PIN auth.
 *
 * A 4-digit PIN is only 10,000 possibilities, so the PIN alone is weak by
 * construction. What makes it safe enough for a football sweepstake is
 * everything around it, all of which lives here:
 *
 *   - PINs are never stored, only scrypt hashes with a per-player salt
 *   - comparison is timing-safe
 *   - 5 wrong tries locks the account, doubling from 1 minute up to an hour
 *   - a per-IP throttle stops someone spraying one PIN across every player
 *   - the most guessable PINs are rejected at set-up
 *   - session tokens are 32 random bytes, stored server-side, httpOnly
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import * as store from "./db.js";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const MAX_FAILURES = 5;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_ATTEMPTS = 50;

/** PINs that are guessed first: repeats, straight runs, and common years. */
const WEAK_PINS = new Set([
  "0000","1111","2222","3333","4444","5555","6666","7777","8888","9999",
  "1234","2345","3456","4567","5678","6789","0123","9876","8765","7654",
  "6543","5432","4321","3210","1212","2121","1122","6969","4242","1313",
  "2000","2001","1999","1998","2020","2021","2022","2023","2024","2025",
]);

export const isValidPinFormat = pin => typeof pin === "string" && /^\d{4}$/.test(pin);
export const isWeakPin = pin => WEAK_PINS.has(pin);

export function hashPin(pin, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(pin, salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return { hash, salt };
}

export function verifyPin(pin, hash, salt) {
  if (!hash || !salt) return false;
  const candidate = scryptSync(pin, salt, SCRYPT.keylen, SCRYPT);
  const known = Buffer.from(hash, "hex");
  if (candidate.length !== known.length) return false;
  return timingSafeEqual(candidate, known);
}

/** Lockout grows 1, 2, 4, 8... minutes and tops out at an hour. */
export function lockoutMs(failureCount) {
  const over = failureCount - MAX_FAILURES;
  if (over < 0) return 0;
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** over);
}

export const clientIp = req =>
  (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown").trim();

export function ipThrottled(req) {
  return store.countAttempts(clientIp(req), IP_WINDOW_MS) >= IP_MAX_ATTEMPTS;
}

/**
 * Check a name + PIN. Returns {ok, player} or {ok:false, error, retryAfter}.
 * Always does the scrypt work even for unknown players so a wrong name and a
 * wrong PIN take the same time.
 */
export function attemptLogin(name, pin, req) {
  store.recordAttempt(clientIp(req));
  if (ipThrottled(req)) return { ok: false, error: "Too many attempts. Try again later." };
  if (!isValidPinFormat(pin)) return { ok: false, error: "PIN must be 4 digits." };

  const player = store.getPlayerByName(name);
  if (!player) {
    hashPin(pin);                                   // burn the same time
    return { ok: false, error: "Wrong name or PIN." };
  }
  if (player.locked_until > Date.now()) {
    return { ok: false, error: "Too many wrong PINs. Locked for a bit.",
             retryAfter: Math.ceil((player.locked_until - Date.now()) / 1000) };
  }
  if (!player.pin_hash) return { ok: false, error: "no-pin", playerId: player.id };

  if (!verifyPin(pin, player.pin_hash, player.pin_salt)) {
    const failures = player.failed_count + 1;
    store.noteFailure(player.id, Date.now() + lockoutMs(failures));
    const left = MAX_FAILURES - failures;
    return { ok: false, error: left > 0 ? `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.`
                                        : "Too many wrong PINs. Locked for a bit." };
  }
  store.clearFailures(player.id);
  return { ok: true, player };
}

export function startSession(res, playerId) {
  const token = randomBytes(32).toString("hex");
  store.createSession(token, playerId, SESSION_TTL_MS);
  res.cookie("lawro_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SECURE_COOKIES === "1",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  return token;
}

export function endSession(req, res) {
  const token = req.cookies?.lawro_session;
  if (token) store.deleteSession(token);
  res.clearCookie("lawro_session", { path: "/" });
}

/** Populates req.user when a valid session cookie is present. */
export function sessionMiddleware(req, _res, next) {
  const token = req.cookies?.lawro_session;
  req.user = token ? store.findSession(token) || null : null;
  next();
}

export const requireLogin = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: "Not signed in." });

export const requireAdmin = (req, res, next) =>
  req.user?.is_admin ? next() : res.status(403).json({ error: "Admins only." });
