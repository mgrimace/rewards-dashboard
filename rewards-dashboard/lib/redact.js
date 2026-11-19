"use strict";

function credentialRedactor(token) {
  if (!token) {
    const identity = (value) => value;
    identity.containsBytes = () => false;
    return identity;
  }
  const jsonEscaped = JSON.stringify(token).slice(1, -1);
  const encoded = encodeURIComponent(token.toWellFormed());
  const encodedAll = [...Buffer.from(token.toWellFormed())]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  const variants = [...new Set([
    token, jsonEscaped, encodeURI(token.toWellFormed()),
    encoded, encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
    encodedAll, encodedAll.toUpperCase(),
    new URLSearchParams({ value: token }).toString().slice(6),
  ])].filter(Boolean).sort((a, b) => b.length - a.length);
  const marker = variants.some((part) => "[redacted]".includes(part)) ? "" : "[redacted]";
  const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const percentPattern = (part) => escape(part).replace(/%([0-9a-f]{2})/gi, (_, hex) =>
    "%" + hex.toLowerCase().replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`));
  const unicodePattern = [...token.split("")].map((char) => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, "0")
      .replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`);
    return `(?:${escape(char)}|\\\\u${hex})`;
  }).join("");
  const pattern = new RegExp([...variants.map(escape), percentPattern(encoded), percentPattern(encodedAll), unicodePattern].join("|"), "g");

  function text(value) {
    // Replace matches in the original text, not in replacement markers.
    return value.replace(pattern, marker);
  }
  function redact(value) {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), redact(item)]));
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      const original = String(value);
      const sanitized = text(original);
      if (sanitized !== original) return sanitized;
    }
    return value;
  }
  const byteVariants = variants.map((part) => Buffer.from(part, "utf8"));
  redact.containsBytes = (buffer) => byteVariants.some((part) => buffer.includes(part));
  return redact;
}

module.exports = { credentialRedactor };
