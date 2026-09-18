/**
 * What Bambu's bulk sales give you.
 *
 * None of this is published anywhere. These are the rates past orders actually
 * came to, and they change from sale to sale — so this file holds a named set
 * per sale rather than one set of numbers that gets edited in place.
 *
 * Editing a set changes what open rounds estimate. It cannot change a closed
 * round: closing freezes a copy of the whole set onto the round, so an order
 * settled in April still explains itself in December.
 *
 * Which set is live is *not* decided here. That changes between sales without
 * wanting a deploy, so it is picked in the UI and stored with the rounds.
 * `default` is only the fallback for a site that has never chosen one.
 */
export default {
  /** Used until somebody picks a different set in the UI. */
  default: "max43",

  sets: {
    /**
     * The usual filament bulk sale — the one most orders have been under.
     *
     * Percentages have to climb with the spool count, or a bigger order would
     * be worth less than a smaller one, and the app refuses to start rather
     * than quietly telling people that. Tiers can be in any order; they are
     * sorted on load.
     */
    max43: {
      label: "Max 43%",
      postagePence: 400,
      freePostageAt: 3,
      tiers: [
        { spools: 4, percent: 30 },
        { spools: 6, percent: 40 },
        { spools: 10, percent: 43 },
      ],
    },

    /**
     * Easter 2026 — steeper early on, and it did not need as many spools to
     * earn free postage.
     */
    max30: {
      label: "Max 30%",
      postagePence: 400,
      freePostageAt: 2,
      tiers: [
        { spools: 3, percent: 35 },
        { spools: 6, percent: 40 },
      ],
    },

    /** No sale on. Postage still applies. */
    none: {
      label: "No sale",
      postagePence: 400,
      freePostageAt: 3,
      tiers: [{ spools: 1, percent: 0 }],
    },
  },
};
