# docker-volume-rbd
Docker volume plugin for ceph rbd.

This plugin uses the ubuntu lts image with a simple script as docker volume plugin api endpoint. The node script uses the standard ceph commandline tools to perform the rbd create, map, unmap, remove and mount operations. This release aligns with the Ceph Quincy release (v19.2), but it may work with other versions as well.

## Ceph Cluster Pre-Requisites

### Ceph Config Directory

- On each Docker host, install `ceph-common` or create the `/etc/ceph` directory if it does not exist.

### Ceph Config File

- Generate a minimal ceph.conf file by running the following command on a Ceph admin or manager node.
- Copy the resulting file to `/etc/ceph/ceph.conf` on all Docker nodes

  ```bash
  ceph config generate-minimal-conf -o ceph.conf
  ```
### Ceph Client Keyring

- Create a keyring file for the user which will access the Ceph cluster and run `rbd` commands.
- Copy the resulting keyring file to `/etc/ceph/` on each docker node

  - For the `admin` user (plugin default), run the following command on a Ceph admin node

    ```bash
    ceph auth print-key client.admin -o ceph.client.admin.keyring
    ```



  - To create a new user (ex: `docker`), run the following command on a Ceph admin node 

    ```bash
    ceph auth get-or-create client.docker mon 'profile rbd' osd 'profile rbd pool=rbd' -o ceph.client.docker.keyring
    ```


## Plugin Installation

### General Usage Installation

- On each docker node, install the plugin with any desired configuration changes. (These can be modified after installation as well)

  ```
  % docker plugin install ajanis/rbd:v19.2 RBD_CONF_POOL="rbd"
  ```
### Plugin Config Options
All available options are:

- `RBD_CONF_POOL`
  - default: `rbd`
- `RBD_CONF_CLUSTER`
  - default: `ceph`
- `RBD_CONF_KEYRING_USER`
  - default: `admin`
- `RBD_CONF_MAP_OPTIONS`
  - default: `--exclusive`: ensures that only one instance can mount the rbd at a time to prevent corruption)
  - Provide a semicolon separated list to provide multiple options directly to the `rbd map` command. eg `RBD_CONF_MAP_OPTIONS="--exclusive;--read-only;--options noshare,lock_on_read"`
- `RBD_CONF_RBD_OPTIONS`
  - default: `"layering,exclusive-lock,object-map,fast-diff,deep-flatten"`
  - Provide a comma separated list of all options passed to the `rbd map --image-feature` argument.
- `RBD_CONF_ORDER`
  - default: `"22"`
  - Block size defined as `2`<sup>`RBD_CONF_ORDER`</sup>

### Build Plugin from Repo Source

(_do not do this on a production system!_)

- Build with the following commands or use the [`build.sh`](./build.sh) build script (_do not do this on a production system!_):

  ```bash
  % git clone https://github.com/ajanis/docker-volume-rbd.git
  
  % cd docker-volume-rbd
  
  # Build Script
  % ./build.sh

  # Manually
  % docker build . -t ajanis/rbd:v19.2

  % id=$(docker create ajanis/rbd:v19.2 true)
  % mkdir rootfs
  % docker export "$id" | sudo tar -x -C rootfs
  % docker rm -vf "$id"
  % docker rmi ajanis/rbd:v19.2

  % docker plugin create ajanis/rbd:v19.2 .
  % rm -rf rootfs

  % docker plugin enable ajanis/rbd:v19.2
  ```

### Post-Install Configuration

If you install with the build script or if you need to change the default volume options after install, then you can configure them using `docker plugin set`

```bash
docker plugin set ajanis/rbd:v19.2 RBD_CONF_POOL="rbd.swarm" RBD_CONF_KEYRING_USER="swarm" RBD_CONF_CLUSTER="ceph" RBD_CONF_MAP_OPTIONS='--exclusive;w--options=noshare'
```


## Volume Creation

In addition to the **Optional** `size` (_Default: 200M_) and `fstype` (_Default: XFS_) options, the volume filesystem can be customized by passing options to mkfs with `mkfs_options` (_No Default_).


**IMPORTANT** : Filesystem options **MUST** be supported by the underlying filesystem utility, e.g.: `mkfs.ext4`, `mkfs.xfs` but should be passed as a string of options as if using the generic `mkfs` command's `fs-options` argument:

*mkfs -t [fstype] [size] fs-options* **[custom mkfs options]**


### Docker Command-Line
```bash
# xfs
% docker volume create -d ajanis/rbd:v19.2 -o fstype=xfs -o size=1G -o mkfs_options='-f -i size=2048 -b size=4096' xfs-vol

# ext4
% docker volume create -d ajanis/rbd:v19.2 -o size=1G -o fstype=ext4 -o mkfs_options='-b 4096 -E stride=16 stripe-width=128' ext4-vol
```

### Docker Compose

```yaml
volumes:
  ceph-rbd-xfs-volume:
    name: ceph-rbd-xfs-volume
    driver: ajanis/rbd:v19.2
    driver_opts:
      fstfype: xfs
      size: 10G
      mkfs_options: "-f -i size=2048 -b size=4096"
  ceph-rbd-ext4-volume:
    name: ceph-rbd-ext4-volume
    driver: ajanis/rbd:v19.2
    driver_opts:
      fstfype: ext4
      size: 10G
      mkfs_options: "-b 4096 -E stride=16 stripe-width=128"
services:
  service1:
    ...
    volumes:
      - type: volume
        source: ceph-rbd-xfs-volume
        target: /ceph-rbd-xfs-volume
      - type: volume
        source: ceph-rbd-ext4-volume
        target: /ceph-rbd-ext4-volume
```
## Warnings

- Do **NOT** mount an rbd-backed filesystem to multiple hosts/containers at the same time.  If you require shared file storage for multiple containers (each with read/write access), use CephFS.
  - Mount a CephFS volume to all of your Docker/Swarm nodes.
  - Create a directory as needed
  - Use a Docker volume `bind` mount to any container needing access.  Ex: `-v /path/to/cephfs/docker:/docker`