import express from "express";
import process from "process";

import KeyedMutex from "./keyedMutex";
import Rbd from "./rbd";
import ReferenceTable from "./referenceTable";
const socketAddress = "/run/docker/plugins/rbd.sock";
const pool = process.env.RBD_CONF_POOL || "rbd";
const cluster = process.env.RBD_CONF_CLUSTER || "ceph"; // ToDo: Not utilized currently
const user = process.env.RBD_CONF_KEYRING_USER || "swarm"; // ToDo: Not utilized currently
const order = process.env.RBD_CONF_ORDER || "22"
const rbd_options = process.env.RBD_CONF_RBD_OPTIONS || "layering,exclusive-lock,object-map,fast-diff,deep-flatten";
const map_options = process.env.RBD_CONF_MAP_OPTIONS ? process.env.RBD_CONF_MAP_OPTIONS.split(';') : ["--exclusive"]; // default to an exclusive lock when mapping to prevent multiple containers attempting to mount the block device
const watcher_wait = parseWatcherWait(process.env.RBD_CONF_WATCHER_WAIT); // seconds to wait for another host's watchers to clear before failing a mount
const rbd = new Rbd({ pool: pool, cluster: cluster, user: user, map_options: map_options, order: order, rbd_options: rbd_options});
const referenceTable = new ReferenceTable();
// Mount/Unmount/Create/Remove for the same volume must not interleave: an overlapping Mount would
// see the other request's fresh mapping as a foreign watcher, or unmount its new mount.
const volumeLocks = new KeyedMutex();

// Keep the default below Docker's plugin request timeout (30s by default), leaving room for the rbd
// calls around the wait; a request Docker has given up on is rolled back rather than completed.
function parseWatcherWait(value: string | undefined): number {
    const fallback = 20;
    if (!value) {
        return fallback;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds;
    }
    console.warn(`Invalid RBD_CONF_WATCHER_WAIT "${value}" (expected seconds); using ${fallback}`);
    return fallback;
}

const app = express();
app.use(express.json({ strict: false, type: req => true }));

// Documentation about docker volume plugins can be found here: https://docs.docker.com/engine/extend/plugins_volume/

app.post("/Plugin.Activate", (request, response) => {
    console.log("Activating rbd volume driver");

    response.json({
        "Implements": ["VolumeDriver"]
    });
});

// Express 4 does not catch rejected promises from async handlers; an escaped error would
// crash the plugin (losing the reference table), so report it to Docker instead.
function handle(fn: (request: express.Request, response: express.Response) => Promise<unknown>) {
    return async (request: express.Request, response: express.Response) => {
        try {
            await fn(request, response);
        }
        catch (error) {
            const errMsg = (error instanceof Error) ? error.message : String(error);
            console.error(errMsg);
            if (!response.headersSent) {
                response.json({ Err: errMsg });
            }
        }
    };
}

// True once Docker has closed the connection without receiving a response (e.g. it timed out).
function trackAbandoned(response: express.Response): () => boolean {
    let abandoned = false;
    response.on("close", () => {
        if (!response.writableFinished) {
            abandoned = true;
        }
    });
    return () => abandoned;
}

function getMountPoint(name: string): string {
    return `/mnt/volumes/${pool}/${name}`;
}

/*
    Instruct the plugin that the user wants to create a volume, given a user specified volume name.
    The plugin does not need to actually manifest the volume on the filesystem yet (until Mount is
    called). Opts is a map of driver specific options passed through from the user request.
*/
app.post("/VolumeDriver.Create", handle(async (request, response) => {
    const req = request.body as { Name: string, Opts: { size: string, fstype: string, mkfs_options: string } };
    const fstype = req.Opts?.fstype || "xfs";
    const size = req.Opts?.size || "200M";
    const mkfs_options = req.Opts?.mkfs_options || "";

    console.log(`Creating rbd volume ${req.Name}`);

    await volumeLocks.run(req.Name, async () => {
        if (await rbd.create(req.Name, size)) {
            let device = await rbd.map(req.Name);
            await rbd.makeFilesystem(fstype, device, mkfs_options);
            await rbd.unMap(req.Name);
        }
    });

    response.json({
        Err: ""
    });
}));


/*
    Delete the specified volume from disk. This request is issued when a user invokes
    docker rm -v to remove volumes associated with a container.
*/
app.post("/VolumeDriver.Remove", handle(async (request, response) => {
    const req = request.body as { Name: string };

    console.log(`Removing rbd volume ${req.Name}`);

    await volumeLocks.run(req.Name, async () => {
        const mountPoint = getMountPoint(req.Name);
        if (await rbd.isMounted(mountPoint)) {
            await rbd.unmount(mountPoint);
        }
        await rbd.unMap(req.Name);
        await rbd.remove(req.Name);
    });

    response.json({
        Err: ""
    });
}));

/*
    Docker requires the plugin to provide a volume, given a user specified volume name.
    Mount is called once per container start. If the same volume_name is requested more
    than once, the plugin may need to keep track of each new mount request and provision
    at the first mount request and deprovision at the last corresponding unmount request.
*/
app.post("/VolumeDriver.Mount", handle(async (request, response) => {
    const req = request.body as { Name: string, ID: string };
    const mountPoint = getMountPoint(req.Name);
    const isAbandoned = trackAbandoned(response);

    console.log(`Mounting rbd volume ${req.Name}`);

    await volumeLocks.run(req.Name, async () => {
        if (isAbandoned()) {
            console.log(`Mount of ${req.Name} for ${req.ID} was abandoned by Docker before it started; skipping`);
            return;
        }

        let { state, device } = await rbd.getMountState(req.Name, mountPoint);

        if (state === "healthy") {
            console.log(`${mountPoint} is already mounted`);
            if (!isAbandoned()) {
                referenceTable.add(req.Name, req.ID);
            }
            return response.json({
                MountPoint: mountPoint,
                Err: ""
            });
        }

        if (state === "stale") {
            // Mounted, but not from this image's current mapping (e.g. the device was unmapped underneath us)
            console.log(`${mountPoint} is a stale mount; lazily unmounting before remounting`);
            await rbd.unmount(mountPoint, true, true);
        }

        if (!device) {
            // Not mapped on this host; refuse if another host is still watching the image
            const watchers = await rbd.waitForNoWatchers(req.Name, watcher_wait * 1000);
            if (watchers.length > 0) {
                const addresses = watchers.map(w => w.address).join(", ");
                throw new Error(`rbd volume ${req.Name} is in use on another host (watchers: ${addresses})`);
            }
            if (isAbandoned()) {
                console.log(`Mount of ${req.Name} for ${req.ID} was abandoned by Docker; not mapping`);
                return;
            }
            device = await rbd.map(req.Name);
        }

        await rbd.mount(device, mountPoint);

        if (isAbandoned()) {
            // Docker reports this Mount as failed and will never send a matching Unmount, so
            // holding the mapping would keep the image locked to this host indefinitely
            if (referenceTable.count(req.Name) === 0) {
                console.log(`Mount of ${req.Name} for ${req.ID} was abandoned by Docker; rolling back`);
                await rbd.unmount(mountPoint);
                await rbd.unMap(req.Name);
            }
            return;
        }

        referenceTable.add(req.Name, req.ID);
        response.json({
            MountPoint: mountPoint,
            Err: ""
        });
    });
}));

/*
    Request the path to the volume with the given volume_name.
*/
app.post("/VolumeDriver.Path", handle(async (request, response) => {
    const req = request.body as { Name: string };
    const mountPoint = getMountPoint(req.Name);

    console.log(`Request path of rbd mount ${req.Name}`);
    if (await rbd.isMounted(mountPoint)) {
        return response.json({
            MountPoint: mountPoint,
            Err: ""
        });
    }
    response.json({ Err: `Volume ${req.Name} is not mounted` });
}));

/*
    Docker is no longer using the named volume. Unmount is called once per container stop.
    Plugin may deduce that it is safe to deprovision the volume at this point.

    ID is a unique ID for the caller that is requesting the mount.
*/
app.post("/VolumeDriver.Unmount", handle(async (request, response) => {
    const req = request.body as { Name: string, ID: string };
    const mountPoint = getMountPoint(req.Name);

    console.log(`Unmounting rbd volume ${req.Name}`);

    await volumeLocks.run(req.Name, async () => {
        const removal = referenceTable.remove(req.Name, req.ID);

        if (removal.remaining > 0) {
            console.log(`Keeping rbd volume ${req.Name} mounted; ${removal.remaining} consumers still active`);
            return;
        }

        if (!removal.removed) {
            // The reference table is in memory, so it is empty after a plugin restart. With no other known
            // consumers, tear down anyway; if an untracked consumer still holds the device, unmap fails as busy.
            console.log(`Unmount requested for ${req.Name} with unknown ID ${req.ID} and no tracked consumers; attempting teardown`);
        }

        const device = await rbd.isMapped(req.Name);
        const wasMounted = await rbd.isMounted(mountPoint);

        if (wasMounted) {
            await rbd.unmount(mountPoint);
        }
        if (device) {
            try {
                await rbd.unMap(req.Name);
            }
            catch (error) {
                if (removal.removed || !wasMounted) {
                    throw error;
                }
                // An untracked consumer (from before a plugin restart) still holds the device; restore
                // our mount so Path and later Mounts keep seeing the volume it is using
                console.log(`rbd volume ${req.Name} is still in use by an untracked consumer; remounting ${mountPoint}`);
                await rbd.mount(device, mountPoint);
            }
        }
    });

    response.json({
        Err: ""
    });
}));

/*
    Get info about volume_name.
*/
app.post("/VolumeDriver.Get", handle(async (request, response) => {
    const req = request.body as { Name: string };
    const mountPoint = getMountPoint(req.Name);

    console.log(`Getting info about rbd volume ${req.Name}`);

    const info = await rbd.getInfo(req.Name);

    if (!info) {
        return response.json({ Err: "" });
    }

    response.json({
        Volume: {
            Name: req.Name,
            Mountpoint: mountPoint,
            Status: {
                size: info.size
            }
        },
        Err: ""
    });
}));

/*
    Get the list of volumes registered with the plugin.
*/
app.post("/VolumeDriver.List", handle(async (request, response) => {
    console.log("Getting list of registered rbd volumes");

    const rbdList = await rbd.list();

    response.json({
        Volumes: rbdList.map(info => {
            return {
                Name: info.image,
            };
        }),
        Err: ""
    });
}));

app.post("/VolumeDriver.Capabilities", (request, response) => {
    console.log("Getting the list of capabilities");

    response.json({
        Capabilities: {
            Scope: "global"
        }
    });
});


app.listen(socketAddress, () => {
    console.log(`Plugin rbd listening on socket ${socketAddress}`);
});
