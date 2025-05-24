# docker-volume-rbd
Docker volume plugin for ceph rbd.

This plugin uses the ubuntu lts image with a simple script as docker volume plugin api endpoint. The node script uses the standard ceph commandline tools to perform the rbd create, map, unmap, remove and mount operations. This release aligns with the Ceph Quincy release (v19.2), but it may work with other versions as well.

## Ceph Cluster Pre-Requisites

### Ceph Config Directory

- On each Docker host, install `ceph-common` or create the `/etc/ceph` directory if it does not exist.

### Ceph Config File

- Generate a minimal ceph.conf file by running the following command on a Ceph admin or manager node.
- Copy the resulting file to `/etc/ceph/ceph.conf` on all Docker nodes

  ```shell
  ceph config generate-minimal-conf -o ceph.conf
  ```
### Ceph Client Keyring

- Create a keyring file for the user which will access the Ceph cluster and run `rbd` commands.
- Copy the resulting keyring file to `/etc/ceph/` on each docker node

  - For the `admin` user (plugin default), run the following command on a Ceph admin node

    ```shell
    ceph auth print-key client.admin -o ceph.client.admin.keyring
    ```



  - To create a new user (ex: `docker`), run the following command on a Ceph admin node 

    ```shell
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

### Build Plugin from Repo Source

(_do not do this on a production system!_)

- Build with or use the [`build.sh`](./build.sh) build script (_do not do this on a production system!_):

  ```
  % git clone https://github.com/ajanis/docker-volume-rbd.git
  
  % cd docker-volume-rbd

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

```shell
docker plugin set ajanis/rbd:v19.2 RBD_CONF_POOL="rbd.custom" RBD_CONF_KEYRING_USER="customuser"
```


## Volume Creation

In addition to the `size` (_Default: 200M_) and `fstype` (_Default: XFS_) options, the volume filesystem can be customized by passing options to mkfs with `mkfs_options` (_No Default_).

Filesystem osptions **MUST** be supported by the underlying filesystem utility, e.g.: `mkfs.ext4`, `mkfs.xfs` but should be passed as a string of options as if using the generic `mkfs` command (following `fs-options` arg)

Example: `mkfs -t <fstype> <size> fs-options [custom mkfs options]`


### Docker Command-Line
```shell
% docker volume create -d ajanis/rbd:v19.2 -o size=150M -o fstype=xfs -o mkfs_option='m
```

size and fstype are optional and default to 200M and xfs respectively.

In my development setup (hyper-v virtualized ceph and docker nodes), the xfs filesystem gives me better write performance over ext4, read performance is about the same.

**WARNING**: do _NOT_ mount a volume on multiple hosts at the same time to prevent filesystem corruption! If you need to share a filesysem between hosts use CephFS or Cifs.