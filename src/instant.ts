// One definition of "a moment in time" for the compiler. A trigger `at(...)`,
// a schema default and the DDL literal that carries it all mean the same
// instant, so they share this rule.
//
// The zone is mandatory: 12:00 in whose clock? Date.parse alone is not enough
// either, because it rolls 2026-02-30 over into March.
const ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

function withColonOffset(text: string): string {
  return text.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

export function isIsoInstant(text: string): boolean {
  if (!ISO.test(text)) return false;
  const at = Date.parse(withColonOffset(text));
  if (Number.isNaN(at)) return false;
  // Date.parse rolls an impossible day over into the next month; compare the
  // calendar day the spec wrote with the day the instant actually lands on.
  const day = text.slice(0, 10);
  return new Date(at).toISOString().slice(0, 10) === day;
}

// The one spelling a stored instant has (a default, an insert, a `where`
// filter): UTC, milliseconds, `T`, `Z`. Two drivers and the model read the
// same value only if the text is the same, so the compiler resolves a default
// through this function instead of publishing it as written.
export function canonicalInstant(text: string): string | null {
  if (!isIsoInstant(text)) return null;
  const at = Date.parse(withColonOffset(text));
  if (Number.isNaN(at)) return null;
  const iso = new Date(at).toISOString();
  const fraction = iso.slice(20, 23);
  return iso.slice(0, 19) + (fraction === '000' ? '' : '.' + fraction) + 'Z';
}

// The spelling MySQL accepts in a DATETIME literal: no `T`, no zone, UTC and
// milliseconds (`DATETIME(3)`). An offset is converted, not stripped: dropping
// `+03:00` would move the instant three hours.
export function utcDateTime(text: string): string | null {
  if (!isIsoInstant(text)) return null;
  const at = Date.parse(withColonOffset(text));
  if (Number.isNaN(at)) return null;
  const iso = new Date(at).toISOString();
  const fraction = iso.slice(20, 23);
  return iso.slice(0, 19).replace('T', ' ') + (fraction === '000' ? '' : '.' + fraction);
}
