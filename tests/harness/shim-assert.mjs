// Browser-side minimal replacement for 'node:assert'/'node:assert/strict',
// used only by the Chrome test runner. Implements the strict-mode subset the
// suite uses. Under real Node the built-in module is imported instead.
function isObj(v) {
  return v !== null && typeof v === "object";
}

function deepEq(a, b, seen) {
  if (Object.is(a, b)) return true;
  if (!isObj(a) || !isObj(b)) return false;
  if (seen.has(a)) return seen.get(a) === b;
  seen.set(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!(k in b)) return false;
    if (!deepEq(a[k], b[k], seen)) return false;
  }
  return true;
}

function fmt(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function ok(v, msg) {
  if (!v) throw new Error(msg || `assert.ok failed: ${fmt(v)}`);
}

export function strictEqual(a, b, msg) {
  if (!Object.is(a, b))
    throw new Error(msg || `strictEqual failed: ${fmt(a)} !== ${fmt(b)}`);
}

export function notStrictEqual(a, b, msg) {
  if (Object.is(a, b))
    throw new Error(msg || `notStrictEqual failed: both ${fmt(a)}`);
}

export function deepStrictEqual(a, b, msg) {
  if (!deepEq(a, b, new Map()))
    throw new Error(msg || `deepStrictEqual failed: ${fmt(a)} !== ${fmt(b)}`);
}

export function fail(msg) {
  throw new Error(msg || "assert.fail called");
}

export function throws(fn, matcher, msg) {
  let threw = false;
  let err;
  try {
    fn();
  } catch (e) {
    threw = true;
    err = e;
  }
  if (!threw) throw new Error(msg || "expected function to throw");
  if (matcher instanceof RegExp && !matcher.test(String(err && err.message)))
    throw new Error(msg || `error message ${String(err && err.message)} did not match ${matcher}`);
  return err;
}

export async function rejects(p, matcher, msg) {
  let threw = false;
  let err;
  try {
    if (typeof p === "function") await p();
    else await p;
  } catch (e) {
    threw = true;
    err = e;
  }
  if (!threw) throw new Error(msg || "expected promise/function to reject");
  if (matcher instanceof RegExp && !matcher.test(String(err && err.message)))
    throw new Error(msg || `rejection ${String(err && err.message)} did not match ${matcher}`);
  return err;
}
