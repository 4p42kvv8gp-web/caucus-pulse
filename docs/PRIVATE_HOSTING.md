# Prepared private hosting plan

Use one small Linux server with persistent local storage, an owner login and local CPU models. This keeps the dashboard, archive, analysis jobs and recovery ledger together. It is the prepared pilot architecture; no host, domain, tunnel, paid plan or collection schedule has been created.

## Host and cost proposal

The prepared service targets Ubuntu 24.04 x86_64, Python 3.12, Node 24.19.x, at least two CPU threads and an 8 GiB memory tier. Start with 80 GB or more of persistent SSD storage. The combined local topic and entity models need more headroom than a static website. The app limits model concurrency; capacity must still be measured on the actual host.

For a US-hosted pilot, a concrete reference option is DigitalOcean's Basic 8 GiB / 4 vCPU / 160 GiB SSD plan, listed at **$48/month**. Its optional daily platform backup is listed at another 30% of the Droplet price, so that combination is **$62.40/month**, before taxes and any domain or separate backup storage. Platform snapshots still need source-removal retention handling. These figures were checked September 8, 2026; verify the actual checkout before purchase. [DigitalOcean pricing](https://www.digitalocean.com/pricing/droplets)

A lower-cost candidate is Hetzner's European CX33: 4 shared vCPUs, 8 GB memory and 80 GB storage. Its June price notice lists **$9.99/month excluding IPv4 and VAT**. Confirm current stock, region and the final order total; the public product page did not establish available inventory for this account. Do not assume its European price applies to a US region. The same prepared Linux runtime can be tested there. [CX33 specifications](https://www.hetzner.com/cloud/cost-optimized/), [current price notice](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)

The existing $400 X credit is a separate provider balance, not hosting money. The app's X controls remain $25/day, $350 total pilot spend and a $50 protected reserve, subject to actual balance verification. The $3.025 connection trial is already exhausted. Local CPU analysis uses no paid model endpoint. Access/backup/domain checkout terms and any hosting expense require a concrete approval before provisioning.

## Runtime package already prepared

- `requirements-nli-linux-cpu.txt` pins 35 CPython 3.12 Linux x86_64 wheels. Their published hashes and dependency metadata were checked; the downloaded package set is about 250 MB. Torch is the official **2.14.0+cpu** wheel, not a CUDA installation. Linux needs glibc 2.28 or newer.
- `scripts/setup-local-classifier.py` selects that lock on Linux and the existing Mac lock on macOS ARM64. Both use hash-checked binary packages. Other architectures are rejected instead of falling back to unpinned packages.
- `deploy/caucus-pulse.service` runs an unprivileged service with an 8 GiB host budget in mind, bounded restarts, two-CPU quota and writes restricted to its data directory. `deploy/caucus-pulse-backup.service` is a manual local backup unit; no timer or deletion policy is enabled.
- `deploy/workspace.env.example` and `deploy/cloudflared.yml.example` contain placeholders only. The named tunnel points to loopback and ends with a catch-all 404. [Cloudflare ingress configuration](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)
- `scripts/host-preflight.js` checks the actual platform, private archive, schema, space, model-file presence and owner-access configuration without starting services or contacting providers. `scripts/host-smoke.js` runs the actual local models on synthetic text and writes a private platform-specific report.

The complete Linux runtime has **not** been executed on this Mac. There is no local Linux VM/container runtime available. The host smoke command has passed on macOS ARM64; this cannot substitute for a Linux execution result. The service restrictions, Cloudflare login, tunnel behavior and host restart still need to be exercised on the selected machine.

## Operator installation order

1. After the specific host is approved, provision the chosen x86_64 machine and install the official signed OS/runtime packages. Create the unprivileged `caucus-pulse` account. Keep the application at the fixed path `/opt/caucus-pulse` and Node at `/opt/node-v24.19.0` or update both service templates to the actual verified Node path. Code should be owned by the deployment administrator; only `/opt/caucus-pulse/data` should be writable by the application user.
2. Copy a reviewed, pinned commit's source and lockfiles into the application directory. Install Node packages with `pnpm install --frozen-lockfile --ignore-scripts`. Do not copy this Mac's `node_modules`, Python environment, unused model experiments, private reference files or whole project mirror to Linux.
3. As the application user, install the selected Python runtime and download the three public pinned model assets:

   ```sh
   python3 scripts/setup-local-classifier.py
   python3 scripts/download-classifier-model.py
   python3 scripts/download-classifier-model.py --entities
   node scripts/download-embedding-model.js bge
   ```

   Setup/download commands are separate from service startup. They do not fetch member posts or send source content to a model provider. The model loaders verify their pinned files and disable remote loading at inference time.
4. Prepare the actual owner Access application for the entire hostname. Fill the private environment file from that application's audience/team/owner settings. Put it at `/etc/caucus-pulse/workspace.env`, readable only by the service manager. Protect the tunnel credentials separately. Keep the firewall closed to port 4317. Follow [Private access](PRIVATE_ACCESS.md) for owner/session/Origin checks.
5. Transfer the pilot archive through an approved private channel as a **verified closed snapshot**, together with the newest removal journal and spending reconciliation records. Transfer the X token separately to owner-only secret storage. Do not copy a live database without its WAL, overwrite a newer archive, move credentials through Git, or activate an old recovery candidate without reconciliation. A completely new installation can initialize an empty archive at first startup; that does not import history or grant collection readiness.
6. With the model service stopped, run the Node/Python tests and `node scripts/host-smoke.js`. In the configured production environment, run `node scripts/host-preflight.js hosted`. Preserve the reports. `systemd-analyze verify` should validate the prepared unit files on that host, and `cloudflared tunnel ingress validate` should validate the actual tunnel configuration. Resolve failures before enabling the units.
7. Start the application under the prepared service and check local `/healthz`. Test the actual owner login over the public hostname, then signed-out and wrong-account denial on pages and APIs. Confirm model readiness, preserved review history, source counts and the spending ledger. Reboot the host and verify the same state. The firewall and origin must still require the signed Access assertion.
8. Make a verified backup on the target disk and perform a staged recovery/removal drill using an isolated synthetic archive. Configure encrypted off-host backups with a specific retention/removal procedure and prove restoration from that location. Provider machine snapshots alone are not the complete source-removal workflow.
9. Enable paid collection only after provider balance/access/pricing are verified, the incomplete List inventory is reconciled, roster evidence is fresh and the chosen cadence has passed bounded recovery checks. Keep collection disabled during the hosting transition. No repeating paid poll unit is included in this prepared package.

## Operations after launch

Monitor process health separately from model queue completion, roster/account freshness, collection checkpoints, source omissions, open billing faults, storage growth, backup age and removal cleanup. A healthy web page does not mean the archive is current. The authenticated Coverage & budget and model-status APIs expose the application state; `/healthz` intentionally exposes only process liveness.

Maintain one application writer host with SQLite on its local disk. Back up before a schema migration. Update source in place while the service is stopped, preserving the real data directory; do not replace the application directory wholesale or point each code release at a fresh empty data directory. An application-code rollback does not authorize restoring an older database or reducing the spending ledger.

The unit's memory/CPU limits and filesystem restrictions are prepared constraints, not measured Linux guarantees. Inspect the actual service status and host security settings after installation. [systemd service semantics](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml), [systemd execution restrictions](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)

The owner work is small: approve one concrete host total, complete the owner login if needed, verify the X balance, and provide real classification judgments. Runtime installation, deployment, monitoring, backup setup and source-level implementation remain development tasks.
