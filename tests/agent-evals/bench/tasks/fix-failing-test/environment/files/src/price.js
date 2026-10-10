// Applies a percentage discount and rounds to cents.
export function applyDiscount(price, percent) {
  const discounted = price - price * percent;
  return Math.round(discounted * 100) / 100;
}
