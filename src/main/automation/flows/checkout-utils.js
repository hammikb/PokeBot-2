/**
 * Shared checkout utilities used across retailer flows.
 */

/**
 * Add a random human-like delay between steps.
 * Bot detection flags interactions that are too fast or too consistent.
 */
export function humanDelay(min = 200, max = 800) {
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)))
}
