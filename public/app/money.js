(function () {
  'use strict';

  // Money is integer paise. Rupee strings are converted with string
  // arithmetic, never floating-point multiplication.

  function formatInr(paise) {
    const negative = paise < 0;
    const abs = Math.abs(paise);
    const rupees = String(Math.floor(abs / 100));
    const fraction = String(abs % 100).padStart(2, '0');
    const head = rupees.slice(0, -3);
    const tail = rupees.slice(-3);
    const grouped = head ? head.replace(/\B(?=(\d{2})+$)/g, ',') + ',' + tail : tail;
    return (negative ? '-' : '') + '₹' + grouped + '.' + fraction;
  }

  function parseRupees(input) {
    if (typeof input !== 'number' && typeof input !== 'string') {
      return { error: 'Enter an amount in rupees' };
    }
    const text = String(input).replace(/[₹,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(text)) {
      return { error: 'Enter a valid amount in rupees, with at most 2 decimals' };
    }
    const [whole, frac = ''] = text.split('.');
    const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
    if (paise === 0) return { error: 'Amount must be greater than zero' };
    return { paise };
  }

  const api = { formatInr, parseRupees };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.Money = api;
  }
})();
