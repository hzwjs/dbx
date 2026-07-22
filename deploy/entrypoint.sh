#!/bin/sh
set -eu

# The data volume is intentionally separate from the image's read-only agent
# bundle. Copy only missing entries so existing connections and driver updates
# in /app/data survive image upgrades, while an empty/new volume is immediately
# usable offline.
source_dir=/opt/dbx/agents
target_dir=${DBX_AGENT_DIR:-/app/data/agents}
mkdir -p "$target_dir"

copy_if_missing() {
  source_path=$1
  target_path=$2
  if [ ! -e "$target_path" ]; then
    mkdir -p "$(dirname "$target_path")"
    cp -a "$source_path" "$target_path"
  fi
}

copy_if_missing "$source_dir/jre-21" "$target_dir/jre-21"
copy_if_missing "$source_dir/drivers/rocketmq" "$target_dir/drivers/rocketmq"

if [ ! -e "$target_dir/state.json" ]; then
  cp -a "$source_dir/state.json" "$target_dir/state.json"
else
  # Keep user-installed drivers and Java settings, but merge the image's
  # built-in RocketMQ/JRE records into an existing data volume. AgentManager
  # uses these records in addition to checking the executable/JAR paths.
  state_tmp="$target_dir/state.json.tmp.$$"
  if jq \
    --argjson image_driver "$(jq -c '.installed_drivers.rocketmq' "$source_dir/state.json")" \
    '.jre_versions = ((.jre_versions // {}) + {"21":"21"})
     | .installed_drivers = ({"rocketmq":$image_driver} + (.installed_drivers // {}))
     | .java_runtime = (.java_runtime // {"mode":"managed"})' \
    "$target_dir/state.json" > "$state_tmp" \
    && mv "$state_tmp" "$target_dir/state.json"; then
    :
  else
    rm -f "$state_tmp"
    echo "Warning: could not merge built-in agent state; preserving existing state.json" >&2
  fi
fi

exec "$@"
