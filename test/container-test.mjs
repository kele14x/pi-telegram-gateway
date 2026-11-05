// Offline checks for the supported Docker/Podman Compose deployment recipes.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shell = "/bin/sh";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const podman = readFileSync(new URL("../compose.podman.yaml", import.meta.url), "utf8");
const dockerUnit = readFileSync(new URL("../contrib/pi-telegram-gateway-docker.service", import.meta.url), "utf8");
const podmanUnit = readFileSync(new URL("../contrib/pi-telegram-gateway-podman.service", import.meta.url), "utf8");
const help = readFileSync(new URL("../scripts/help.mjs", import.meta.url), "utf8");
const setupService = compose.split("\n  pi-setup:\n")[1].split("\nvolumes:\n")[0];
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
  assert.match(setupService, new RegExp(`^      ${name}:$`, "m"), "unset proxies must stay unset rather than suppress saved settings");
}
assert(!setupService.includes("env_file:") && !setupService.includes("TELEGRAM_BOT_TOKEN"), "setup must not receive Telegram credentials");
assert(!compose.includes("userns_mode:") && !compose.includes("/workspace:Z"), "Podman settings must not leak into Docker");
assert.match(dockerfile, /^FROM node:26-slim$/m, "the image must build on the official Node 26 runtime");
assert(!/^FROM (?!node:26-slim)/m.test(dockerfile), "the build must stay single-stage on node:26-slim");
assert(!/\bCOPY --from=/.test(dockerfile), "no foreign runtime may be copied into the image");
assert.match(dockerfile, /apt-get install[^\n]*\blibatomic1\b[^\n]*\blibstdc\+\+6\b/, "Node shared-library dependencies must be installed");
const installedPackages = dockerfile.match(/apt-get install -y --no-install-recommends ([^\n]+)/)[1].trim().split(/\s+/);
for (const name of ["build-essential", "pkg-config", "python3", "python3-venv", "python3-pip", "jq", "zip", "unzip", "openssh-client", "tmux"]) {
  assert(installedPackages.includes(name), `the image must include ${name}`);
}
for (const name of ["cmake", "ninja-build"]) {
  assert(!installedPackages.includes(name), `the image must not explicitly install ${name}`);
}
assert(!/\buseradd\b/.test(dockerfile), "node:26-slim already provides the node account and home directory");
assert.match(dockerfile, /^USER node$/m, "the image must remain non-root by default");
assert.match(dockerfile, /^ENTRYPOINT \[\]$/m, "the upstream docker-entrypoint.sh must be cleared");
assert.match(podman, /\/workspace:Z/, "only the Podman workspace mount gets a private SELinux label");
assert.match(readme, /--userns=keep-id --security-opt label=disable/, "credential import must not relabel host pi configuration");
assert.match(readme, /agent:\/host:ro"/, "credential import must keep the host mount read-only");
assert.match(readme, /sh -ec '\n    umask 077/, "credential import must fail on errors and create private files");
assert.match(readme, /-v pi-telegram-gateway_data:\/data/);
const podmanCommands = [readme, podman, help].flatMap(text => text.match(/podman-compose --in-pod=false[^\n]+/g) ?? []);
assert(podmanCommands.length >= 5);
for (const command of podmanCommands) assert(command.includes("-p pi-telegram-gateway"), "all Podman commands must share the user unit's project name");
for (const action of ["ExecStart", "ExecStop"]) {
  assert.match(dockerUnit, new RegExp(`^${action}=.* compose -p pi-telegram-gateway -f docker-compose.yml `, "m"));
  assert.match(podmanUnit, new RegExp(`^${action}=.* -p pi-telegram-gateway `, "m"));
}
assert.match(dockerUnit, /^ExecStart=.* up gateway$/m);
assert.match(dockerUnit, /^ExecStop=.* down$/m);
assert.match(dockerUnit, /^Requires=docker\.service$/m);
assert.match(dockerUnit, /^After=.*docker\.service/m);
assert.match(dockerUnit, /^WantedBy=multi-user\.target$/m);
assert(!dockerUnit.includes("compose.podman.yaml"), "the Docker unit must not load the Podman override");
assert.match(podmanUnit, /^WantedBy=default\.target$/m);
assert.match(readme, /contrib\/pi-telegram-gateway-docker\.service/, "the Docker autostart template must be documented");

const setupRecipe = readme.match(/```bash\n(COMPOSE_BIN=[\s\S]*?)\n```/)[1];
const providerSelection = setupRecipe.split("\nif [ -x")[0];
const providerTemporary = mkdtempSync(join(tmpdir(), "pi-gateway-podman-provider-"));
try {
  const home = join(providerTemporary, "home");
  const bin = join(providerTemporary, "bin");
  const emptyBin = join(providerTemporary, "empty-bin");
  const venvBin = join(home, ".local", "venvs", "podman-compose", "bin");
  for (const directory of [bin, emptyBin, venvBin]) mkdirSync(directory, { recursive: true });
  const distroProvider = join(bin, "podman-compose");
  const venvProvider = join(venvBin, "podman-compose");
  const customProvider = join(bin, "custom-provider");
  const envProvider = join(bin, "env-provider");
  for (const path of [distroProvider, venvProvider, customProvider, envProvider]) {
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const env = { HOME: home, PATH: bin, COMPOSE_BIN: "", PODMAN_COMPOSE: "" };
  for (const [overrides, expected] of [
    [{ COMPOSE_BIN: customProvider, PODMAN_COMPOSE: envProvider }, customProvider],
    [{ PODMAN_COMPOSE: envProvider }, envProvider],
    [{}, distroProvider],
    [{ PATH: emptyBin }, venvProvider],
  ]) {
    const selected = execFileSync(shell, ["-c", providerSelection + '\nprintf "%s" "$COMPOSE_BIN"'], {
      env: { ...env, ...overrides }, encoding: "utf8",
    });
    assert.equal(selected, expected, "provider selection must preserve overrides and support distro and venv installs");
  }
  const missing = spawnSync(shell, ["-c", setupRecipe], {
    env: { ...env, COMPOSE_BIN: join(bin, "missing-provider") }, encoding: "utf8",
  });
  assert.equal(missing.status, 0);
  assert.match(missing.stderr, /Set COMPOSE_BIN or PODMAN_COMPOSE/);
  assert(!existsSync(join(home, ".config")), "missing providers must not render or register a unit");
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  execFileSync(shell, ["-c", setupRecipe], {
    cwd: new URL("../", import.meta.url),
    env: { ...env, PATH: `${bin}:/usr/bin:/bin`, COMPOSE_BIN: customProvider },
  });
  const renderedUnit = readFileSync(join(home, ".config", "systemd", "user", "pi-telegram-gateway-podman.service"), "utf8");
  assert(renderedUnit.includes(`ExecStart=${customProvider} --in-pod=false -p pi-telegram-gateway`), "the rendered unit must use the selected provider and shared project name");
  assert(!renderedUnit.includes("@COMPOSE_BIN@"));

  const importHost = join(providerTemporary, "import-host");
  const importAgent = join(providerTemporary, "import-agent");
  mkdirSync(importHost);
  mkdirSync(importAgent);
  writeFileSync(join(importHost, "auth.json"), "{}\n", { mode: 0o644 });
  const importRecipe = readme.match(/pi-telegram-gateway:latest sh -ec '([\s\S]*?)\n  '/)[1];
  const importScript = importRecipe.replaceAll("/host/", `${importHost}/`).replaceAll("/data/pi-agent/", `${importAgent}/`);
  execFileSync(shell, ["-ec", importScript]);
  assert.equal(readFileSync(join(importAgent, "auth.json"), "utf8"), "{}\n");
  assert.equal(statSync(join(importAgent, "auth.json")).mode & 0o777, 0o600, "imported credentials must be private");
  const failedImport = spawnSync(shell, ["-ec", importScript.replaceAll(`${importAgent}/`, `${providerTemporary}/missing-agent/`)]);
  assert.notEqual(failedImport.status, 0, "credential copy failures must not be hidden");
} finally {
  rmSync(providerTemporary, { recursive: true, force: true });
}

const dockerRecipe = readme.match(/```bash\n(DOCKER_BIN=[\s\S]*?)\n```/)[1];
const dockerTemporary = mkdtempSync(join(tmpdir(), "pi-gateway-docker-unit-"));
try {
  const bin = join(dockerTemporary, "bin");
  const unitDir = join(dockerTemporary, "systemd");
  mkdirSync(bin, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  const dockerBin = join(bin, "docker");
  const systemctl = join(bin, "systemctl");
  const sudo = join(bin, "sudo");
  for (const path of [dockerBin, systemctl]) writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(sudo, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
  execFileSync(shell, ["-c", dockerRecipe], {
    cwd: new URL("../", import.meta.url),
    env: { PATH: `${bin}:/usr/bin:/bin`, DOCKER_BIN: "", SYSTEMD_UNIT_DIR: unitDir },
  });
  const renderedUnit = readFileSync(join(unitDir, "pi-telegram-gateway-docker.service"), "utf8");
  assert(renderedUnit.includes(`ExecStart=${dockerBin} compose -p pi-telegram-gateway -f docker-compose.yml up gateway`), "the rendered Docker unit must start the Compose stack");
  assert(renderedUnit.includes(`ExecStop=${dockerBin} compose -p pi-telegram-gateway -f docker-compose.yml down`), "the rendered Docker unit must stop the Compose stack");
  assert(!renderedUnit.includes("@DOCKER_BIN@") && !renderedUnit.includes("@DOCKER_DIR@"), "the rendered Docker unit must not keep template placeholders");
} finally {
  rmSync(dockerTemporary, { recursive: true, force: true });
}
console.log("Container deployment recipe tests passed.");
