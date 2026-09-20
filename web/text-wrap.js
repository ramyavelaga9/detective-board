// Wraps text for a fixed-width card. A classic script (loaded before app.js) whose
// only job is this one function, so a unit test can load it without a browser.

/**
 * Wraps `text` into at most `maxLines` lines of up to `maxChars` characters. If the text is cut, the
 * last line ends in an ellipsis. A single word longer than a line is cut to fit instead of overflowing.
 */
function wrapWithEllipsis(text, maxChars, maxLines) {
  const words = String(text ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word));
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = last.endsWith("…") ? last : `${last.slice(0, maxChars - 1).trimEnd()}…`;
  return kept;
}
