export function ema(values: number[], period: number): number {
  if (values.length < period) {
    throw new Error(`Not enough values for EMA(${period})`);
  }
  const alpha = 2 / (period + 1);
  let current = sma(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) {
    current = values[i] * alpha + current * (1 - alpha);
  }
  return current;
}

export function rsi(values: number[], period: number): number {
  if (values.length < period + 1) {
    throw new Error(`Not enough values for RSI(${period})`);
  }

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function sma(values: number[]): number {
  if (values.length === 0) {
    throw new Error("SMA requires at least one value");
  }
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

export function pctChange(start: number, end: number): number {
  if (start === 0) {
    return 0;
  }
  return ((end - start) / start) * 100;
}

export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number
): number {
  if (highs.length !== lows.length || highs.length !== closes.length) {
    throw new Error("ATR arrays must have same length");
  }
  if (highs.length < period + 1) {
    throw new Error(`Not enough values for ATR(${period})`);
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < highs.length; i += 1) {
    const tr1 = highs[i] - lows[i];
    const tr2 = Math.abs(highs[i] - closes[i - 1]);
    const tr3 = Math.abs(lows[i] - closes[i - 1]);
    trueRanges.push(Math.max(tr1, tr2, tr3));
  }

  let atrValue = sma(trueRanges.slice(0, period));
  for (let i = period; i < trueRanges.length; i += 1) {
    atrValue = (atrValue * (period - 1) + trueRanges[i]) / period;
  }
  return atrValue;
}
