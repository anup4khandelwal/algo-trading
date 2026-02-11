export interface LtpProvider {
  getLtp(symbol: string): Promise<number>;
}

export class MapLtpProvider implements LtpProvider {
  constructor(private ltpMap: Map<string, number>) {}

  async getLtp(symbol: string): Promise<number> {
    const price = this.ltpMap.get(symbol);
    if (price === undefined) {
      throw new Error(`LTP not available for ${symbol}`);
    }
    return price;
  }
}
