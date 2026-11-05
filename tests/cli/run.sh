#!/usr/bin/env bash
# shellcheck disable=SC2016 # bash -c scripts take their values as arguments
# The Linux CLI's tests: each case copies the CLI into a scratch stack and runs it against a fake
# docker, git, hostname and lsblk first on PATH, so nothing on the host is touched and no drive is
# mounted. Run it from a worktree or CI, never the live stack folder. Plain bash: an `ok` or `FAIL`
# line per case, non-zero exit on any failure.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repository=$(cd "$here/../.." && pwd)
fakes="$here/fakes"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
stack="$scratch/storage-compose"
state="$scratch/state"

failures=0
case_name=""
case_failed=false
output=""
status=0

new_stack() {
    rm -rf "$stack" "$state"
    mkdir -p "$stack/data" "$stack/gateway" "$state"
    cp "$repository/docker-compose.sh" "$repository/docker-compose.ps1" "$repository/config.env.example" "$stack/"
    cp "$repository/gateway/tailnet-node.sh" "$stack/gateway/"
    chmod +x "$stack/docker-compose.sh"
    : >"$state/calls"
    write_config
}

write_config() {
    printf '%s\n' STORAGE_NODE=pc STORAGE_HOST=storage.example.ts.net TS_AUTHKEY=tskey-test >"$stack/config.env"
}

begin() {
    case_name=$1
    case_failed=false
    output=""
    new_stack
}

finish() {
    if $case_failed; then
        failures=$((failures + 1))
        printf '     %s\n' "${output//$'\n'/$'\n'     }"
    else
        echo "ok   $case_name"
    fi
}

# run_cli ARGUMENTS...: runs the scratch CLI with the fakes, keeping its output and exit code.
run_cli() {
    output=$(cd "$scratch" && PATH="$fakes:$PATH" FAKE_DOCKER_DIR="$state" bash "$stack/docker-compose.sh" "$@" 2>&1)
    status=$?
}

check() {
    local description=$1
    shift
    if ! "$@"; then
        $case_failed || echo "FAIL $case_name"
        echo "     - $description"
        case_failed=true
    fi
}

status_is() { [ "$status" -eq "$1" ]; }
said() { grep -qF -- "$1" <<<"$output"; }
not_said() { ! said "$1"; }
called() { grep -qE -- "$1" "$state/calls"; }
not_called() { ! called "$1"; }
no_calls() { [ ! -s "$state/calls" ]; }
config_value_of() { sed -n "s/^$1=//p" "$stack/config.env" | tail -n 1; }

## Dispatch

begin "an unknown command shows the usage and exits 1"
run_cli bogus
check "exits 1" status_is 1
check "shows the usage" said "Usage: ./docker-compose.sh ["
check "runs nothing" no_calls
finish

begin "the usage lists every dispatched command"
run_cli help
for command in accept-smart credentials data delete down drives init-config kopia-user logs migrate-labels restart scrub \
    snapraid status sync up url; do
    check "'$command' in the usage" said "  $command "
done
finish

begin "each compose command reaches its service"
run_cli status
check "status lists every container" called "^docker compose ps -a$"
run_cli logs mounter
check "logs follows the service" called "^docker compose logs -f mounter$"
run_cli sync --anyway
check "sync runs in snapraid with its arguments" called "^docker compose exec -T snapraid snapraid.sh run sync --anyway$"
run_cli scrub
check "scrub runs in snapraid" called "^docker compose exec -T snapraid snapraid.sh run scrub$"
run_cli snapraid status
check "snapraid writes the config first" called "^docker compose exec -T snapraid snapraid.sh config$"
check "then runs snapraid with it" called "^docker compose exec -T snapraid snapraid -c /etc/snapraid.conf status$"
run_cli kopia-user me@laptop
check "kopia-user runs in kopia" called "^docker compose exec -T kopia kopia.sh user me@laptop$"
run_cli accept-smart data2
check "accept-smart runs in the mounter" called "^docker compose exec -T mounter mounter.sh accept-smart data2$"
run_cli down
check "down stops the stack" called "^docker compose down$"
finish

begin "drives lists the block devices"
run_cli drives
check "exits 0" status_is 0
check "lsblk with labels and serials" called "^lsblk -o NAME,SIZE,FSTYPE,LABEL,MODEL,SERIAL,TRAN$"
finish

begin "url prints the tailnet and local addresses"
run_cli url
check "exits 0" status_is 0
check "the tailnet URL" said "https://storage.example.ts.net"
check "the local URLs" said "http://localhost:8442"
check "runs nothing" no_calls
finish

begin "up without config.env refuses before anything starts"
rm "$stack/config.env"
run_cli up
check "exits 1" status_is 1
check "says to run init-config" said "No config.env - run './docker-compose.sh init-config' first."
check "builds and starts nothing" no_calls
finish

## Windows-only commands

begin "attach is declared Windows-only and is in the ps1's usage table"
check "windows_only names attach" grep -qxF "windows_only=(attach)" "$repository/docker-compose.sh"
check "the ps1 has it" grep -qE '^[[:space:]]*"attach"[[:space:]]*=' "$repository/docker-compose.ps1"
finish

begin "attach is refused on Linux and touches nothing"
run_cli attach
check "exits 1" status_is 1
check "shows the usage" said "Usage: ./docker-compose.sh ["
check "the usage does not offer it" not_said "attach"
check "runs nothing" no_calls
finish

## init-config

begin "init-config names this host and generates a notification topic once"
rm "$stack/config.env"
run_cli init-config
check "exits 0" status_is 0
check "copies the example" [ -f "$stack/config.env" ]
check "the host name in lower case" [ "$(config_value_of STORAGE_NODE)" = storage-box ]
check "a 32-hex topic" grep -qE '^NTFY_TOPIC=storage-[0-9a-f]{32}$' "$stack/config.env"
topic=$(config_value_of NTFY_TOPIC)
run_cli init-config
check "a second run exits 0" status_is 0
check "keeps the host" said "config.env already names this host."
check "keeps the topic" [ "$(config_value_of NTFY_TOPIC)" = "$topic" ]
finish

## data

begin "data status by default"
run_cli data
check "exits 0" status_is 0
check "shows the submodule" called "^git -C .* submodule status -- data$"
run_cli data STATUS
check "case does not matter" status_is 0
finish

begin "data use points the submodule at owner/repo@ref"
run_cli data use someone/storage-data@v2
check "exits 0" status_is 0
check "the GitHub URL" called "^git -C .* config submodule.data.url https://github.com/someone/storage-data.git$"
check "the origin too" called "^git -C .*/data remote set-url origin https://github.com/someone/storage-data.git$"
check "fetches the ref" called "^git -C .*/data fetch -q origin v2$"
check "checks it out" called "^git -C .*/data checkout -q FETCH_HEAD$"
check "says where data is" said "data now at 0abc123"
finish

begin "data use without a ref takes main, and without a source the template"
run_cli data use someone/storage-data
check "main by default" called "^git -C .*/data fetch -q origin main$"
: >"$state/calls"
run_cli data use
check "the template URL" called "^git -C .* config submodule.data.url https://github.com/intisy-compose/storage-data-template.git$"
check "at main" called "^git -C .*/data fetch -q origin main$"
finish

begin "data use keeps the user of a URL and splits the ref at the last @"
run_cli data use git@github.com:someone/storage-data.git@winter
check "exits 0" status_is 0
check "keeps git@" called "^git -C .* config submodule.data.url git@github.com:someone/storage-data.git$"
check "fetches the ref" called "^git -C .*/data fetch -q origin winter$"
: >"$state/calls"
run_cli data use https://me@git.example.org/someone/storage-data.git@v3
check "a URL's user too" called "^git -C .* config submodule.data.url https://me@git.example.org/someone/storage-data.git$"
check "and its ref" called "^git -C .*/data fetch -q origin v3$"
: >"$state/calls"
run_cli data use git@github.com:someone/storage-data.git
check "a user with no ref" called "^git -C .* config submodule.data.url git@github.com:someone/storage-data.git$"
check "takes main" called "^git -C .*/data fetch -q origin main$"
finish

begin "data use refuses a ref that is empty or an option"
for source in someone/storage-data@-oops someone/storage-data@ git@github.com:someone/x.git@--upload-pack=x; do
    : >"$state/calls"
    run_cli data use "$source"
    check "'$source' exits 1" status_is 1
    check "'$source' says why" said "A data ref must not be empty or start with '-'"
    check "'$source' touches no repository" no_calls
done
finish

begin "data with an unknown subcommand shows the usage"
run_cli data bogus
check "exits 1" status_is 1
check "shows the usage" said "Usage: ./docker-compose.sh ["
finish

## delete

api_token=tskey-api-k123-SECRET456

# delete_ready: an array whose tailscaled.state names nOURS123CNTRL, in a tailnet that also has another
# node of the same name, and a TS_API_TOKEN in config.env.
delete_ready() {
    local current profiles
    current=$(printf 'profile-ab12' | base64 | tr -d '\n')
    profiles=$(printf '{"ab12":{"ID":"ab12","Key":"profile-ab12","NodeID":"nOURS123CNTRL"}}' | base64 | tr -d '\n')
    printf '{"_current-profile":"%s","_profiles":"%s"}\n' "$current" "$profiles" >"$state/array-state"
    printf '%s\n' "nOURS123CNTRL storage" "nOTHER45CNTRL storage" >"$state/tailnet-devices"
    echo "TS_API_TOKEN=$api_token" >>"$stack/config.env"
}

device_left() { grep -q "^$1 " "$state/tailnet-devices"; }

# called_before FIRST SECOND: the first call matching FIRST comes before the first matching SECOND.
called_before() {
    local first second
    first=$(grep -nE -- "$1" "$state/calls" | head -n 1 | cut -d: -f1)
    second=$(grep -nE -- "$2" "$state/calls" | head -n 1 | cut -d: -f1)
    [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ]
}

begin "delete stops tailscale, removes the node by its ID and the array's state, then downs"
delete_ready
run_cli delete
check "exits 0" status_is 0
check "tailscale stops first" called_before "^docker compose stop tailscale$" "^curl https://api.tailscale.com/"
check "reads the state on the array of ARRAY_PREFIX" called "^docker compose exec -T mounter cat /mnt/storage/storage-data1/.storage/tailscale/tailscaled.state$"
check "removes our node by its ID" called "^curl https://api.tailscale.com/api/v2/device/nOURS123CNTRL Authorization: Bearer $api_token$"
check "our node is gone" bash -c '! grep -q "^nOURS123CNTRL " "$1"' _ "$state/tailnet-devices"
check "says so, by STORAGE_HOST" said "Removed storage.example.ts.net from the tailnet."
check "the state goes from the array" called "^docker compose exec -T mounter rm -rf /mnt/storage/storage-data1/.storage/tailscale$"
check "then the down" called_before "mounter rm -rf" "^docker compose down$"
check "says it is deleted" said "Deleted. The volumes stay in Docker; remove this folder to finish."
finish

begin "delete leaves a node of the same name alone"
delete_ready
run_cli delete
check "the other storage stays" device_left nOTHER45CNTRL
check "one API call" [ "$(grep -c "^curl https://api.tailscale.com/" "$state/calls")" -eq 1 ]
finish

begin "delete never puts the token on a command line or in its output"
delete_ready
run_cli delete
check "no credential on argv" not_called "CREDENTIAL ON ARGV"
check "the fake would catch one" bash -c 'FAKE_DOCKER_DIR="$1" "$2/curl" -H "Authorization: Bearer x" https://api.tailscale.com/api/v2/device/n1 </dev/null >/dev/null; [ $? -eq 99 ]' _ "$state" "$fakes"
check "the token is not in the output" not_said "$api_token"
finish

begin "delete without TS_API_TOKEN prints the manual step and clears the state"
delete_ready
sed -i '/^TS_API_TOKEN=/d' "$stack/config.env"
run_cli delete
check "exits 0" status_is 0
check "no API call" not_called "^curl "
check "names the Machines page and the node" said "Remove storage.example.ts.net (node ID nOURS123CNTRL) on the Machines page: https://login.tailscale.com/admin/machines"
check "the state goes" called "mounter rm -rf "
check "still downs" called "^docker compose down$"
finish

begin "an API error keeps the array's state, still downs and fails"
delete_ready
echo 500 >"$state/tailnet-status"
run_cli delete
check "exits 1" status_is 1
check "names the status" said "The Tailscale API answered HTTP 500, so storage.example.ts.net was not removed."
check "says the state is kept" said "The array's tailnet state is kept, so delete can run again."
check "no rm" not_called "mounter rm -rf"
check "still downs" called "^docker compose down$"
check "never says deleted" not_said "Deleted."
finish

begin "a state that names no node removes nothing and still downs"
delete_ready
echo '{}' >"$state/array-state"
run_cli delete
check "exits 1" status_is 1
check "no API call" not_called "^curl "
check "no rm" not_called "mounter rm -rf"
check "still downs" called "^docker compose down$"
finish

begin "no state on the array calls no API and still downs"
delete_ready
rm "$state/array-state"
run_cli delete
check "exits 0" status_is 0
check "says so" said "No node identity on the array, so no node is removed from the tailnet."
check "no API call" not_called "^curl "
check "still downs" called "^docker compose down$"
finish

begin "delete with the array not mounted refuses and touches nothing"
delete_ready
echo false >"$state/mounter-running"
run_cli delete
check "exits 1" status_is 1
check "says to run up first" said "The node identity is on the array, which is not mounted; run './docker-compose.sh up' first, then delete."
check "no compose call" not_called "^docker compose"
check "no API call" not_called "^curl "
finish

if [ "$failures" -gt 0 ]; then
    echo "$failures case(s) failed"
    exit 1
fi
echo "all cases passed"
