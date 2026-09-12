import { Inngest } from "inngest";

/**
 * Shared Inngest client instance for P2E Inferno.
 *
 * Import this wherever you need to send events or define functions.
 * The app id must match across all usages — changing it will break
 * event routing in Inngest Cloud.
 */
export const inngest = new Inngest({ id: "p2einferno" });
