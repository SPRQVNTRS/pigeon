/**
 * Group envelope recipients by the inbound domain that owns them. Pure.
 *
 * The domain is the part after the last '@', compared case-insensitively.
 * Recipients on no known (enabled) domain are only counted.
 */

export interface InboundDomainRef {
  id: string;
  appId: string;
  /** Lower case, as stored. */
  name: string;
}

export interface RecipientGroup<D extends InboundDomainRef> {
  domain: D;
  recipients: string[];
}

export interface RecipientGrouping<D extends InboundDomainRef> {
  groups: Array<RecipientGroup<D>>;
  unmatchedCount: number;
}

export function recipientDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

/** Distinct lower-case domains of a recipient list, for the domain lookup. */
export function recipientDomains(recipients: readonly string[]): string[] {
  const names = recipients.map(recipientDomain).filter((name): name is string => name !== null);
  return [...new Set(names)];
}

export function groupRecipientsByDomain<D extends InboundDomainRef>(opts: {
  recipients: readonly string[];
  domains: readonly D[];
}): RecipientGrouping<D> {
  const byName = new Map(opts.domains.map((domain) => [domain.name.toLowerCase(), domain]));
  const groups = new Map<string, RecipientGroup<D>>();
  let unmatchedCount = 0;

  for (const recipient of opts.recipients) {
    const name = recipientDomain(recipient);
    const domain = name === null ? undefined : byName.get(name);
    if (!domain) {
      unmatchedCount += 1;
      continue;
    }
    const group = groups.get(domain.id) ?? { domain, recipients: [] };
    if (!group.recipients.includes(recipient)) group.recipients.push(recipient);
    groups.set(domain.id, group);
  }

  return { groups: [...groups.values()], unmatchedCount };
}
