# Systems registry (template)

Copy this folder to `knowledge/` (git-ignored) and fill it in. Names, hosts, ports and paths only:
never passwords, tokens or keys. Agents read `knowledge/systems.md` through `knowledge.get {"topic":"systems"}`,
and the `## Summary` section (keep it under about 1 KB) is added to every task prompt.

## Summary

- ATLAS app: machine, ports, how it starts, where the DB and backups live.
- Businesses: name, key, domain for each.
- Mail, payments, social: what is connected.
- Code and hosting: GitHub accounts and repos, hosting.
- Network and homelab: VLANs and the hosts agents may reach.
- Models: subscriptions and local model hosts.

## ATLAS app

## Businesses and domains

## Payments

## Code and hosting

## Network

## Homelab hosts

## Models and workers
