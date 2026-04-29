let simulationNowMs = Date.now();

export function getSimulationNowMs(): number {
  return simulationNowMs;
}

export function setSimulationNowMs(nowMs: number): void {
  simulationNowMs = nowMs;
}
