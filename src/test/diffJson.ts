/** Strings, booleans, lengths and keys equal; numbers within `tol`. Returns the differences (empty = equal). */
export function diffJson(
  actual: unknown,
  expected: unknown,
  tol = 1e-6,
  path = '$',
  out: string[] = [],
): string[] {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !(Math.abs(actual - expected) <= tol))
      out.push(`${path}: ${String(actual)} vs ${expected}`);
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      out.push(`${path}: length mismatch`);
    else
      expected.forEach((e, i) =>
        diffJson(actual[i], e, tol, `${path}[${i}]`, out),
      );
  } else if (expected !== null && typeof expected === 'object') {
    if (
      actual === null ||
      typeof actual !== 'object' ||
      Array.isArray(actual)
    ) {
      out.push(`${path}: not an object`);
    } else {
      const a = actual as Record<string, unknown>;
      const e = expected as Record<string, unknown>;
      const ka = Object.keys(a).sort().join();
      const ke = Object.keys(e).sort().join();
      if (ka !== ke) out.push(`${path}: keys ${ka} vs ${ke}`);
      else
        for (const k of Object.keys(e))
          diffJson(a[k], e[k], tol, `${path}.${k}`, out);
    }
  } else if (actual !== expected) {
    out.push(
      `${path}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`,
    );
  }
  return out;
}
