# Environment setup

This guide configures Hozamo on HiveOS/Linux, Windows or macOS. The standalone
release reads `.env` from its own directory and then from the **current working
directory** every time it starts. The Node.js source version reads it from the
current working directory. Operating-system environment variables override
values from either file.

API credentials should be stored in `.env`, not passed as command-line
arguments. Create dedicated exchange credentials with spot-trading permission
only and disable withdrawals.

## What you need

- an extracted Hozamo release package or a Git checkout of the repository
- internet access to the configured exchanges
- an API key and secret for each exchange whose private endpoints you use

Node.js 20 or newer is required only for a source package or Git checkout. The
standalone packages include their own Node.js runtime. Git is only required if
you choose to clone the source.

## Choose an installation method

| Method | Recommended for | Additional installation step |
| --- | --- | --- |
| Standalone release | Regular users | None; Node.js is embedded |
| Source release | Users who want the packaged Node.js source | Install Node.js 20 or newer |
| Git checkout | Contributors or users following the latest source | Run `npm ci` after cloning and after each update |

Release archives are available on the
[Hozamo Releases page](https://github.com/cryptokalandok/hozamo/releases).
The original Linux and Windows source archives remain available alongside the
standalone executables. Do not run `npm install` inside an extracted source
release archive because its production dependencies are already included.

## HiveOS and Linux

These commands apply to HiveOS, Ubuntu and other Debian-based distributions.
HiveOS terminals normally run as `root`; in that case omit `sudo` from the
commands.

### 1. Install basic tools and, when needed, Node.js

First install the tools needed to download and configure Node.js:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl nano
```

Skip the rest of this step when using a standalone package. For a source
package or Git checkout, install the current Node.js LTS release system-wide.
A system-wide installation gives scheduled tasks a stable Node.js path:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
```

The commands above use the
[NodeSource Debian packages](https://github.com/nodesource/distributions). If
your distribution is not Debian-based, select its installation method on the
[official Node.js download page](https://nodejs.org/en/download).

Verify the installation before continuing:

```bash
node --version
npm --version
command -v node
```

The Node.js version must start with `v20` or a newer major version. If an older
version is displayed, remove or update the previous Node.js installation before
continuing.

### 2. Download Hozamo

For the recommended installation, download the standalone Linux `.tar.gz` asset
from the [latest release](https://github.com/cryptokalandok/hozamo/releases/latest),
then extract it. Replace `X.Y.Z` with the downloaded version:

```bash
tar -xzf hozamo-vX.Y.Z-linux-x64-standalone.tar.gz
cd hozamo-vX.Y.Z-linux-x64-standalone
```

To use the Node.js source release instead, download and extract
`hozamo-vX.Y.Z-linux.tar.gz`. It requires Node.js but already contains its
production dependencies.

To use a Git checkout instead, install Git, clone the repository and install
the exact dependencies recorded in `package-lock.json`:

```bash
sudo apt-get install -y git
git clone https://github.com/cryptokalandok/hozamo.git
cd hozamo
npm ci
```

Run `npm ci` again after pulling a new source version. Skip it when using the
release archive because that package already contains production dependencies.

### 3. Create the configuration

Create the local configuration from the tracked example:

```bash
cp .env.example .env
nano .env
```

Save the file in `nano` with `Ctrl+O`, press `Enter`, then exit with `Ctrl+X`.
Restrict the file so only its owner can read or modify it:

```bash
chmod 600 .env
```

### 4. Verify the installation

Verify that Hozamo starts from this directory:

```bash
./hozamo --help
```

For the source package or Git checkout, use `node hozamo --help`. The npm smoke
scripts are also available from source and verify DNS and exchange connectivity
without submitting an order:

```bash
npm run smoke:coinex
npm run smoke:safetrade
```

If you installed from Git and want to validate the source checkout as well,
run:

```bash
npm run check
npm test
```

### HiveOS and cron working directory

Changing to the Hozamo directory remains the clearest cron or HiveOS setup,
although the standalone executable can also find `.env` beside itself. For
example:

```cron
0 12 * * * cd /path/to/hozamo && ./hozamo balance --exchange coinex --coin BTC >> /var/log/hozamo.log 2>&1
```

For a source installation, keep `/usr/bin/node ./hozamo` and confirm the actual
Node.js path before using it in cron:

```bash
command -v node
```

Avoid placing API keys directly in a crontab or HiveOS flight sheet command.

## Windows

The following commands use PowerShell. You do not need Windows Subsystem for
Linux (WSL).

### 1. Install Node.js only when using source

Skip this step when using the standalone package. For a source package or Git
checkout on Windows 10 or 11, install the current Node.js LTS release with
`winget`:

```powershell
winget install --id OpenJS.NodeJS.LTS -e
```

If `winget` is unavailable, download and run the LTS Windows installer from the
[official Node.js download page](https://nodejs.org/en/download). Keep the
installer's default option that adds Node.js to `PATH`; npm is installed with
Node.js.

Close PowerShell after the installation and open a new window, then verify the
commands and the installed Node.js path:

```powershell
node --version
npm --version
(Get-Command node).Source
```

The Node.js version must start with `v20` or a newer major version.

### 2. Download Hozamo

For the recommended installation:

1. Open the [latest release](https://github.com/cryptokalandok/hozamo/releases/latest).
2. Download `hozamo-vX.Y.Z-windows-x64-standalone.zip` from **Assets**.
3. Right-click the downloaded file, select **Extract All**, and move the
   extracted directory somewhere permanent, for example into your user
   directory.
4. Open PowerShell in the extracted Hozamo directory.

You can also change directory manually. Replace the example path with the
actual extracted directory:

```powershell
Set-Location "$HOME\Hozamo\hozamo-vX.Y.Z-windows-x64-standalone"
```

The standalone package contains `hozamo.exe` and does not need Node.js or npm.
The existing `hozamo-vX.Y.Z-windows.zip` source package is also available; it
requires Node.js and contains its production dependencies, so do not run
`npm install` in it.

To use the Git checkout instead, install Git, open a new PowerShell window,
clone the repository and install its locked dependencies:

```powershell
winget install --id Git.Git -e
```

Close PowerShell, open a new window, then run:

```powershell
git clone https://github.com/cryptokalandok/hozamo.git
Set-Location .\hozamo
npm ci
```

Run `npm ci` again after pulling a new source version.

### 3. Create the configuration

Create and edit the configuration file from the Hozamo directory:

```powershell
Copy-Item .env.example .env
notepad .env
```

Keep the Hozamo directory in your Windows user directory rather than a
shared or cloud-synchronized folder. `.env` is ignored by Git, but it is still
a normal local file and must not be emailed, uploaded or committed.

### 4. Verify the installation

Verify the installation from the Hozamo directory:

```powershell
.\hozamo.exe --help
```

For a source package or Git checkout, use `.\hozamo.cmd --help`. Its npm smoke
scripts remain available:

```powershell
npm run smoke:coinex
npm run smoke:safetrade
```

If you installed from Git and want to validate the source checkout as well,
run:

```powershell
npm run check
npm test
```

PowerShell variables can temporarily override `.env` for the current terminal:

```powershell
$env:HOZAMO_EXCHANGE = "coinex"
.\hozamo.exe price --pair BTC-USDT
```

Do not use `setx` for exchange secrets. It stores them persistently in the
Windows user environment and only affects newly opened processes.

### Windows Task Scheduler working directory

When creating a scheduled task, configure these fields:

| Task Scheduler field | Value |
| --- | --- |
| Program/script | `C:\path\to\hozamo\hozamo.exe` |
| Add arguments | The Hozamo command and its options |
| Start in | `C:\path\to\hozamo` |

Do not put quotes in **Start in**. Setting it to the repository directory is
recommended and allows Hozamo to find `.env`. Use an absolute executable path
and test the exact command interactively before scheduling it. For a source
installation, keep `node.exe` as Program/script and pass the absolute `hozamo`
script path before the command options.

## macOS

Download `hozamo-vX.Y.Z-macos-arm64-standalone.tar.gz` for an Apple Silicon Mac
or `hozamo-vX.Y.Z-macos-x64-standalone.tar.gz` for an Intel Mac. Extract it,
open Terminal in the extracted directory, and configure it in the same way as
Linux:

```bash
cp .env.example .env
chmod 600 .env
./hozamo --help
```

The macOS executable is ad-hoc signed but not Apple-notarized. Gatekeeper may
block its first launch. Approve that individual executable from **System
Settings → Privacy & Security**; do not disable Gatekeeper globally.

## Configure `.env`

Choose a default exchange and add credentials for the exchange you use. A
minimal CoinEx configuration looks like this:

```dotenv
HOZAMO_EXCHANGE=coinex
HOZAMO_DNS_RESULT_ORDER=ipv4first

COINEX_API_KEY=replace-with-a-trading-only-access-id
COINEX_API_SECRET=replace-with-the-secret-key
```

A minimal SafeTrade configuration looks like this:

```dotenv
HOZAMO_EXCHANGE=safetrade
HOZAMO_DNS_RESULT_ORDER=ipv4first

SAFETRADE_API_KEY=replace-with-a-trading-only-api-key
SAFETRADE_API_SECRET=replace-with-the-api-secret
```

You may keep credentials for both exchanges in the same file and select one
with `--exchange safetrade|coinex` per command. The command-line option takes
precedence over `HOZAMO_EXCHANGE`.

The `.env` syntax is one `NAME=value` entry per line. Comments must start on
their own line with `#`. Do not add `export` before variable names. Single- or
double-quoted values are accepted, although ordinary API credentials usually
do not need quotes.

## Environment variable reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `HOZAMO_EXCHANGE` | No | Default exchange: `safetrade` or `coinex`; defaults to `safetrade` |
| `HOZAMO_DNS_RESULT_ORDER` | No | DNS preference: `ipv4first`, `ipv6first` or `verbatim`; defaults to `ipv4first` |
| `HOZAMO_PROXY_URL` | No | Global HTTP(S) forward proxy used for every exchange request |
| `HOZAMO_BUY_RESERVE_PERCENT` | No | Quote-balance reserve for percentage-sized buys; defaults to `0.5` |
| `HOZAMO_TIMEOUT_MS` | No | Shared positive integer request timeout in milliseconds; defaults to `15000` |
| `SAFETRADE_API_KEY` | Private SafeTrade calls | SafeTrade trading API key |
| `SAFETRADE_API_SECRET` | Private SafeTrade calls | SafeTrade API secret |
| `SAFETRADE_BASE_URL` | No | SafeTrade API base URL override |
| `SAFETRADE_TIMEOUT_MS` | No | SafeTrade-specific timeout when the shared timeout is unset |
| `COINEX_API_KEY` | Private CoinEx calls | CoinEx access ID |
| `COINEX_API_SECRET` | Private CoinEx calls | CoinEx secret key |
| `COINEX_BASE_URL` | No | CoinEx API base URL override |
| `COINEX_TIMEOUT_MS` | No | CoinEx-specific timeout when the shared timeout is unset |
| `COINEX_WINDOW_TIME_MS` | No | CoinEx request validity window; defaults to `5000` |

Leave `HOZAMO_PROXY_URL` unset or empty for a direct connection. If a proxy
is needed, use one of these forms:

```dotenv
HOZAMO_PROXY_URL=http://proxy.example.com:3128
HOZAMO_PROXY_URL=https://username:password@proxy.example.com:8443
```

URL-encode special characters in proxy usernames or passwords. See the
[proxy setup guide](proxy.md) before operating a shared proxy.

## Verify private API access safely

Start with a read-only balance request for the configured exchange. These
examples use the source command; standalone users should use `./hozamo` on
Linux/macOS or `.\hozamo.exe` on Windows instead:

```bash
node hozamo balance --exchange coinex --coin BTC,USDT
```

On Windows PowerShell with the source package, use `.\hozamo.cmd` instead.
Before submitting a real order, run the intended command with `--dryrun`. A
dryrun performs private read-only calls and local validation but does not
submit the order:

```bash
node hozamo order --exchange coinex --type market --side sell --pair BTC-USDT --amount 0.001 --dryrun
```

Use an amount that is available in the account. After validating the output,
test the smallest real order permitted by the selected exchange.

## Troubleshooting

### Hozamo does not see `.env`

For a standalone installation, first confirm that `.env` exists beside the
executable. Hozamo also checks the current directory:

```bash
pwd
ls -la .env
```

In PowerShell:

```powershell
Get-Location
Get-Item .env
```

Also check whether an operating-system environment variable is overriding the
same `.env` entry.

### Private calls report missing credentials

Confirm that the credentials match the exchange selected by `--exchange` or
`HOZAMO_EXCHANGE`, and that each entry uses the exact `NAME=value` syntax.
The price command is public, so a successful price lookup does not prove that
private credentials are configured correctly.

### SafeTrade returns HTTP 403

Hozamo prefers IPv4 by default, but SafeTrade may still require the public
outbound IP address to be allowlisted. Run the SafeTrade smoke test with
`--debug`, confirm the host's public IPv4 address and contact SafeTrade support
if the request is blocked. A configured global proxy can provide a stable
outbound address.
