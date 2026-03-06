/**
 * Test helpers — minimal test framework (no dependencies)
 */

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

export function describe(name, fn) {
  console.log(`\n📦 ${name}`);
  fn();
}

export function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failedTests++;
    failures.push({ name, error: err.message });
    console.log(`  ❌ ${name}`);
    console.log(`     → ${err.message}`);
  }
}

export async function testAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failedTests++;
    failures.push({ name, error: err.message });
    console.log(`  ❌ ${name}`);
    console.log(`     → ${err.message}`);
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertIncludes(arr, item, message) {
  if (!arr.includes(item)) {
    throw new Error(message || `Expected array to include ${JSON.stringify(item)}`);
  }
}

export function assertType(value, type, message) {
  if (typeof value !== type) {
    throw new Error(message || `Expected type ${type}, got ${typeof value}`);
  }
}

export function assertJsonParseable(str, message) {
  try {
    JSON.parse(str);
  } catch {
    throw new Error(message || `String is not valid JSON: ${str.slice(0, 100)}...`);
  }
}

export function summary() {
  console.log('\n' + '='.repeat(50));
  console.log(`Tests: ${passedTests} passed, ${failedTests} failed, ${totalTests} total`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
  }
  console.log('='.repeat(50));
  return failedTests === 0;
}
