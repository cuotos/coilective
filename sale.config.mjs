/**
 * What Bambu's bulk sale tends to give you.
 *
 * None of this is published anywhere. These are the rates past orders actually
 * came to, so they drift, and this file is where you correct them — edit,
 * commit, redeploy. Nothing else needs touching.
 *
 * The figures drive the estimate on an open round ("two more spools and it is
 * about 40% off") and what the close dialog opens on. They never decide what
 * anybody owes: that comes from the discount you type in when the round
 * closes, against the real receipt.
 */
export default {
  /** Postage when the order has not earned its way out of it, in pence. */
  postagePence: 400,

  /** Spools at which postage stops being charged, and stays free above. */
  freePostageAt: 3,

  /**
   * Percent off, by how many spools are in the sale.
   *
   * Any order — they are sorted on load. Percentages have to climb with the
   * spool count, or a bigger order would be worth less than a smaller one,
   * and the app refuses to start rather than quietly telling people that.
   */
  tiers: [
    { spools: 4, percent: 30 },
    { spools: 6, percent: 40 },
    { spools: 10, percent: 43 },
  ],
};
