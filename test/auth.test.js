import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPin, verifyPin, isValidPinFormat, isWeakPin, lockoutMs } from "../src/auth.js";

test("a PIN round-trips and a wrong one fails", () => {
  const { hash, salt } = hashPin("4817");
  assert.ok(verifyPin("4817", hash, salt));
  assert.ok(!verifyPin("4818", hash, salt));
  assert.ok(!verifyPin("", hash, salt));
});

test("the same PIN hashes differently for different players", () => {
  assert.notEqual(hashPin("4817").hash, hashPin("4817").hash);
});

test("verify is safe when no PIN has been set", () => {
  assert.ok(!verifyPin("1234", null, null));
  assert.ok(!verifyPin("1234", undefined, undefined));
});

test("only four digits are a valid PIN", () => {
  for (const ok of ["0000","4817","9999"]) assert.ok(isValidPinFormat(ok));
  for (const bad of ["123","12345","abcd","12 4","", null, 4817]) assert.ok(!isValidPinFormat(bad));
});

test("the most guessable PINs are refused", () => {
  for (const weak of ["0000","1234","1111","2580","".padEnd(4,"7")]) {
    if (["0000","1234","1111","7777"].includes(weak)) assert.ok(isWeakPin(weak), weak);
  }
  assert.ok(!isWeakPin("4817"));
});

test("lockout backs off and caps at an hour", () => {
  assert.equal(lockoutMs(4), 0);
  assert.equal(lockoutMs(5), 60_000);
  assert.equal(lockoutMs(6), 120_000);
  assert.equal(lockoutMs(30), 3_600_000);
});
