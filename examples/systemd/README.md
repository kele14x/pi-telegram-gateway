# Unsupported direct-host systemd example

**Docker Compose (or rootless Podman Compose) is the supported way to run
pi-telegram-gateway.** These files are a reference copy of the former
host-run Linux service management. They are not installed by `npm`, are not
referenced by `package.json`, and are not part of `npm test`.

Use this only if you deliberately run the gateway straight from a checkout with
Node.js ≥ 24 instead of the container image. It uses your host pi configuration
(`~/.pi/agent`) and the checkout's `.env` and sessions.

## Files

| File | Purpose |
| --- | --- |
| `linux-service.mjs` | installs/removes a per-user systemd unit |
| `rotate-logs.mjs` | archives non-empty logs before a managed launch |
| `linux-service-test.mjs` | offline test with a fake `systemctl` |
| `rotation-test.mjs` | offline log-rotation test |

## Commands

Run these from the repository root as your normal user, without `sudo`:

```bash
node examples/systemd/linux-service.mjs autostart:setup
node examples/systemd/linux-service.mjs start:daemon
node examples/systemd/linux-service.mjs restart:daemon
node examples/systemd/linux-service.mjs status
node examples/systemd/linux-service.mjs stop
node examples/systemd/linux-service.mjs autostart:remove
```

The generated unit points at `index.ts` in the repository root and runs it with
`node --env-file-if-exists=.env`. Logs go to `logs/gateway.log` and
`logs/gateway-err.log`; `logs/archive/` keeps the newest 20 rotated files per
log type.

## Tests

```bash
node examples/systemd/linux-service-test.mjs
node examples/systemd/rotation-test.mjs
```

The systemd test uses temporary files and a fake service manager. It never
installs or starts a real unit.

## Related

- Supported deployment: see the root `README.md` (`docker compose`) and
  `compose.podman.yaml` for rootless Podman.
- Container autostart templates for the supported deployment live in `contrib/`:
  `pi-telegram-gateway-docker.service` (system unit for rootful Docker) and
  `pi-telegram-gateway-podman.service` (user unit for rootless Podman). They
  supervise a Compose stack, not a direct host process.
