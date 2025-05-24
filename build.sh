#!/bin/bash

# Default values
pluginTag="v19.2"
pluginName="ajanis/rbd"

# Parse options with getopt (supports both short and long)
OPTIONS=$(getopt --options t:n: --long tag:,name: --name "$0" -- "$@")
if [[ $? -ne 0 ]]; then
  exit 2
fi

eval set -- "$OPTIONS"

# Process options
while true; do
  case "$1" in
    -v|--pluginTag)
      pluginTag="$2"
      shift 2
      ;;
    -n|--name)
      pluginName="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "Unexpected option: $1"
      exit 3
      ;;
  esac
done

# Log setup
logfile="plugin_build_$(date +%Y%m%d_%H%M%S).log"

# Redirect all output to log and console
exec > >(tee -a "$logfile") 2>&1

# Print commands as they run
set -x

pluginNameTagged="${pluginName}:${pluginTag}"
echo "Building plugin: ${pluginNameTagged}"

# Cleanup
docker plugin disable "${pluginNameTagged}" -f
docker plugin rm "${pluginNameTagged}" -f
sudo rm -rf rootfs

# Rebuild plugin
git pull
docker build . -t "${pluginNameTagged}"

id=$(docker create "${pluginNameTagged}" true)
mkdir rootfs
docker export "$id" | tar -x -C rootfs
docker rm -vf "$id"
docker rmi "${pluginNameTagged}"

# Create and enable plugin
sudo docker plugin create "${pluginNameTagged}" .
docker plugin enable "${pluginNameTagged}"

# List Plugins
docker plugin ls

