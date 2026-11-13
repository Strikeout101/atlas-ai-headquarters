# ATLAS SSH Host Manager

The SSH Host Manager is in Settings > SSH Hosts. It stores password or pasted private-key credentials encrypted in the database. API responses expose only `has_credential` and `has_passphrase`, never saved secret material. The SSH connection is opened by the backend through `ssh2`, so the UI and task-scoped agent tools do not receive credentials.

## Setup

1. Set a long random `OAUTH_ENCRYPTION_SECRET` in the server environment or its private `.env` before adding hosts. Preserve this value securely when moving ATLAS; the encrypted credentials cannot be decrypted without the same key. Do not commit the `.env` file.
2. In Settings > SSH Hosts, add a host, choose password or private key, and enter its credential. Saved credentials are not shown again. Editing the host can replace them.
3. Probe the host's public fingerprint. Verify it against a trusted source before pinning it. A changed fingerprint blocks test and command connections.
4. Test the SSH connection. Grant individual agents access to that host.

An agent grant permits a request, not execution. Each agent SSH command creates a pending approval with its exact command text and target. The owner reviews it in Settings > SSH Hosts. Approval can be consumed once, only by the same task and agent for the exact command. Denied or changed commands cannot run. Owner commands entered directly in the Settings console are distinct from agent requests. Command metadata, hashes, status, output sizes, and times are audited; raw command output is not stored in the run log.

## Portability and isolation

The connection uses Node `ssh2` and encrypted credentials, with no dependency on Windows OpenSSH key files. When moving ATLAS to a Proxmox VM, move the database and provide the same external encryption secret. Verify network reachability and each pinned host key before use.

The task-scoped gateway does not give workers the global API token, and known server secrets are removed from CLI process environments. This is an application boundary, not an OS sandbox: a worker running under the same operating-system user as ATLAS may still be able to read local files, including a private `.env` or database backup. For strong separation, run worker processes under a different OS account/container without access to the ATLAS database, environment file, or host-manager service credentials. Keep the server bind/firewall restricted to the intended management network.

Existing key-path SSH targets remain non-operational legacy entries until edited with a new credential and pinned fingerprint. No migration copies raw private keys into the database automatically.
