#!/bin/sh
set -eu

# The data volume is intentionally separate from the image's read-only agent
# bundle. Copy only missing entries so existing connections and driver updates
# in /app/data survive image upgrades, while an empty/new volume is immediately
# usable offline.
source_dir=/opt/dbx/agents
target_dir=${DBX_AGENT_DIR:-${DBX_DATA_DIR:-/app/data}/agents}
case "$target_dir" in
  /*) ;;
  *) target_dir="$(pwd)/$target_dir" ;;
esac

# Do not follow a volume-provided symlink for the agent root or any path below
# it. This keeps all initialization writes inside the selected data directory.
check_root_path() {
  path=$1
  if [ -L "$path" ]; then
    echo "Refusing symlink agent path: $path" >&2
    exit 1
  fi
}

has_blocking_component() {
  path=$1
  while [ "$path" != "$target_dir" ] && [ "$path" != "/" ]; do
    [ -L "$path" ] && return 0
    [ -e "$path" ] && [ ! -d "$path" ] && return 0
    path=$(dirname "$path")
  done
  return 1
}

has_blocking_parent() {
  has_blocking_component "$(dirname "$1")"
}

jar_is_usable() {
  jar_candidate=$1
  [ -f "$jar_candidate" ] && [ ! -L "$jar_candidate" ] && ! has_blocking_parent "$jar_candidate" \
    && [ -s "$jar_candidate" ] \
    && unzip -p "$jar_candidate" META-INF/MANIFEST.MF 2>/dev/null \
    | grep -Eq '^Main-Class:[[:space:]]*[^[:space:]]'
}

jre_is_usable() {
  java_candidate=$1
  [ -x "$java_candidate" ] && [ ! -L "$java_candidate" ] && ! has_blocking_parent "$java_candidate" \
    && timeout 5 "$java_candidate" -version >/dev/null 2>&1
}

check_root_path "$target_dir"
if [ -e "$target_dir" ] && [ ! -d "$target_dir" ]; then
  echo "Refusing non-directory agent path: $target_dir" >&2
  exit 1
fi
mkdir -p "$target_dir"

copy_file_if_missing() {
  source_path=$1
  target_path=$2
  if [ -L "$target_path" ] || [ -e "$target_path" ]; then
    return 0
  fi
  if has_blocking_component "$target_path"; then
    echo "Skipping symlink agent path: $target_path" >&2
    return 0
  fi
  mkdir -p "$(dirname "$target_path")"
  cp -a "$source_path" "$target_path"
}

remove_invalid_file() {
  target_path=$1
  if [ -f "$target_path" ] && [ ! -L "$target_path" ] && [ ! -s "$target_path" ]; then
    :
  elif [ -f "$target_path" ] && [ ! -L "$target_path" ]; then
    :
  else
    return 0
  fi
  if has_blocking_parent "$target_path"; then
    echo "Skipping unsafe agent path: $target_path" >&2
    return 1
  fi
  rm -f "$target_path"
}

copy_tree_missing() {
  source_root=$1
  target_root=$2
  if [ -L "$target_root" ]; then
    echo "Skipping unsafe agent directory: $target_root" >&2
    return 0
  fi
  if has_blocking_component "$target_root"; then
    echo "Skipping unsafe agent directory: $target_root" >&2
    return 0
  fi
  mkdir -p "$target_root"
  find "$source_root" -mindepth 1 -print | while IFS= read -r source_path; do
    relative_path=${source_path#"$source_root"/}
    target_path="$target_root/$relative_path"
    if [ -d "$source_path" ] && [ ! -L "$source_path" ]; then
      if ! has_blocking_component "$target_path"; then
        mkdir -p "$target_path"
      fi
    else
      copy_file_if_missing "$source_path" "$target_path"
    fi
  done
}

jar_path="$target_dir/drivers/rocketmq/agent.jar"
jre_java_path="$target_dir/jre-21/bin/java"
jar_was_usable=0
jre_was_usable=0
jar_is_usable "$jar_path" && jar_was_usable=1
jre_is_usable "$jre_java_path" && jre_was_usable=1
if [ "$jar_was_usable" -eq 0 ] && [ -f "$jar_path" ] && [ ! -L "$jar_path" ]; then
  remove_invalid_file "$jar_path" || :
fi
if [ "$jre_was_usable" -eq 0 ] && [ -f "$jre_java_path" ] && [ ! -L "$jre_java_path" ]; then
  remove_invalid_file "$jre_java_path" || :
fi

copy_tree_missing "$source_dir/jre-21" "$target_dir/jre-21"
copy_tree_missing "$source_dir/drivers/rocketmq" "$target_dir/drivers/rocketmq"

# `cp -a` preserves the read-only permissions of the image bundle. The
# initialized data copy is intentionally writable so Driver Manager can later
# replace or uninstall the agent/JRE without mutating the image layer.
find "$target_dir" -type d -exec chmod u+rwx {} +
find "$target_dir" -type f -exec chmod u+rw {} +

jar_is_usable=0
jre_is_usable=0
jar_is_usable "$jar_path" && jar_is_usable=1
jre_is_usable "$jre_java_path" && jre_is_usable=1

state_needs_merge=1
stale_rocketmq_jre=0
if [ -e "$target_dir/state.json" ] && jq -e '.installed_drivers.rocketmq and ((.jre_versions["21"] // .jre_version) != null)' "$target_dir/state.json" >/dev/null 2>&1; then
  state_needs_merge=0
fi
if [ -e "$target_dir/state.json" ] && [ ! -L "$target_dir/state.json" ]; then
  existing_rocketmq_jre=$(jq -r '.installed_drivers.rocketmq.jre // empty' "$target_dir/state.json" 2>/dev/null || true)
  if [ -n "$existing_rocketmq_jre" ] && [ "$existing_rocketmq_jre" != "21" ] \
    && ! jre_is_usable "$target_dir/jre-$existing_rocketmq_jre/bin/java"; then
    stale_rocketmq_jre=1
  fi
fi

if [ ! -e "$target_dir/state.json" ] && [ ! -L "$target_dir/state.json" ]; then
  cp -a "$source_dir/state.json" "$target_dir/state.json"
elif [ -L "$target_dir/state.json" ]; then
  echo "Warning: refusing to replace symlink state.json; preserving existing state" >&2
elif [ "$jar_is_usable" -eq 1 ] && [ "$jre_is_usable" -eq 1 ] \
  && { [ "$jar_was_usable" -eq 0 ] || [ "$jre_was_usable" -eq 0 ] || [ "$state_needs_merge" -eq 1 ] || [ "$stale_rocketmq_jre" -eq 1 ]; }; then
  # Keep user-installed drivers and Java settings, but merge the image's
  # built-in RocketMQ/JRE records into an existing data volume. AgentManager
  # uses these records in addition to checking the executable/JAR paths.
  if state_tmp=$(mktemp "$target_dir/.state.json.XXXXXX"); then
    replace_builtin=0
    if [ "$jar_was_usable" -eq 0 ] || [ "$jre_was_usable" -eq 0 ] || [ "$stale_rocketmq_jre" -eq 1 ]; then
      replace_builtin=1
    fi
    if jq \
      --argjson image_driver "$(jq -c '.installed_drivers.rocketmq' "$source_dir/state.json")" \
      --argjson replace_builtin "$replace_builtin" \
      '.jre_versions = ((.jre_versions // {}) + {"21":"21"})
       | .installed_drivers = (if $replace_builtin == 1
           then ((.installed_drivers // {}) + {"rocketmq":$image_driver})
           else ({"rocketmq":$image_driver} + (.installed_drivers // {}))
           end)
       | .java_runtime = (.java_runtime // {"mode":"managed"})' \
      "$target_dir/state.json" > "$state_tmp" \
      && mv "$state_tmp" "$target_dir/state.json"; then
      :
    else
      rm -f "$state_tmp"
      echo "Warning: could not merge built-in agent state; preserving existing state.json" >&2
    fi
  else
    echo "Warning: could not create a secure state temp file; preserving existing state.json" >&2
  fi
fi

if [ -f "$target_dir/state.json" ] && [ ! -L "$target_dir/state.json" ]; then
  chmod u+rw "$target_dir/state.json"
fi

if [ "$jar_is_usable" -eq 0 ] || [ "$jre_is_usable" -eq 0 ]; then
  echo "Warning: built-in RocketMQ agent or JRE is unavailable under $target_dir" >&2
fi

exec "$@"
