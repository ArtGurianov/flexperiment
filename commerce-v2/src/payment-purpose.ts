/** Preserve exact merchant text. Same conservative Unicode/UTF-16 contract as Refref V2. */
export function validPaymentPurpose(value: unknown, maxLength = 512): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value !== value.trim()) return false;
  // Controls must refuse, not alter frozen order text.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) return false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
