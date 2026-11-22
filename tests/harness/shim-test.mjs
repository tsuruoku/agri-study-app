// Browser-side minimal replacement for 'node:test' used only by the Chrome test
// runner (tests/harness/runner.html). Under real Node these test files import
// the built-in module instead. Supports the subset the suite uses:
// test(name, fn) where fn is sync or async.
const registered = [];

export function test(name, fn) {
  registered.push({ name, fn });
}

export async function run() {
  const results = [];
  for (const t of registered) {
    try {
      await t.fn({});
      results.push({ name: t.name, ok: true });
    } catch (e) {
      results.push({ name: t.name, ok: false, error: String((e && e.stack) || e) });
    }
  }
  return results;
}
