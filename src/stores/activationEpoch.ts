/** Bumped on every project switch so a slower, earlier switch can tell it lost. */
let epoch = 0;

export function nextActivationEpoch(): number {
  epoch += 1;
  return epoch;
}

export function isCurrentActivation(token: number): boolean {
  return token === epoch;
}
