export function toFiniteNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}
