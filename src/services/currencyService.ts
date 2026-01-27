import logger from '../utils/logger';

export class CurrencyService {
  // Base currency is XAF
  private static readonly exchangeRates: Record<string, number> = {
    XAF: 1,
    XOF: 1, // Fixed parity
    EUR: 655.957, // Fixed parity
    CAD: 450, // Approximate
    USD: 610, // Approximate
  };

  private static readonly symbols: Record<string, string> = {
    XAF: 'FCFA',
    XOF: 'FCFA',
    EUR: '€',
    CAD: '$',
    USD: '$',
  };

  /**
   * Converts an amount from one currency to another
   */
  static convert(amount: number, from: string = 'XAF', to: string = 'XAF'): number {
    if (from === to) return amount;

    // First convert to base (XAF)
    const rateFrom = this.exchangeRates[from] || 1;
    const amountInXaf = amount * rateFrom;

    // Then convert to target
    const rateTo = this.exchangeRates[to] || 1;
    const convertedAmount = amountInXaf / rateTo;

    return Math.round(convertedAmount * 100) / 100;
  }

  /**
   * Finds amounts in text and converts them
   * Example: "Économise 50000FCFA" -> "Économise 111.11$" if target is CAD
   */
  static convertText(text: string, targetCurrency: string, sourceCurrency: string = 'XAF'): string {
    if (!text || targetCurrency === sourceCurrency) return text;

    // Regex to find patterns like "50000 FCFA", "50 000FCFA", "50000F", etc.
    // Also captures just numbers if they are followed by common indicators or just in context
    const currencySuffixes = ['FCFA', 'XAF', 'XOF', 'F', 'CFA'];
    const suffixRegex = currencySuffixes.join('|');

    const regex = new RegExp(`(\\d+[\\d\\s.,]*)\\s*(${suffixRegex})`, 'gi');

    return text.replace(regex, (match, amountStr, suffix) => {
      // Clean amount string (remove spaces)
      const cleanAmountStr = amountStr.replace(/\s/g, '').replace(',', '.');
      const amount = parseFloat(cleanAmountStr);

      if (isNaN(amount)) return match;

      const converted = this.convert(amount, sourceCurrency, targetCurrency);
      const symbol = this.symbols[targetCurrency] || targetCurrency;

      // format: 123.45 $ or 123.45 €
      return `${converted.toLocaleString()}${symbol}`;
    });
  }

  static getSymbol(currency: string): string {
    return this.symbols[currency] || currency;
  }
}
