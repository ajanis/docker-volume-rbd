import util from 'util';
import child_process from "child_process";
import typia from 'typia';
const execFile = util.promisify(child_process.execFile);
import { mkdir, readFile, realpath, rmdir } from "fs/promises";
import { log } from 'console';

type RBDOptions = {
    pool: string,
    cluster: string,
    user: string,
    map_options: string[],
    order: string,
    rbd_options: string
};

interface RBDMapEntry {
    id: string,
    pool: string,
    namespace: string,
    name: string,
    snap: string,
    device: string
}

interface RBDListEntry {
    image: string,
    id: string,
    size: number,
    format: number,
}

interface RBDWatcher {
    address: string,
    client: number,
    cookie: number,
}

interface RBDStatus {
    watchers: RBDWatcher[],
}

const rbdShowMapped = typia.json.createValidateParse<RBDMapEntry[]>();
const rbdList = typia.json.createValidateParse<RBDListEntry[]>();
const rbdStatus = typia.json.createValidateParse<RBDStatus>();

export type MountState = "unmounted" | "healthy" | "stale";

// /proc/mounts escapes space, tab, newline and backslash as octal sequences
function decodeMountField(field: string): string {
    return field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

async function resolveDevice(device: string): Promise<string> {
    try {
        return await realpath(device);
    } catch {
        return device;
    }
}

export default class Rbd {
    // ToDo: Actually used the passed in options for cluster and user
    constructor(readonly options: RBDOptions, private readonly pollIntervalMs: number = 1000) { }

    private rbdBaseArgs(): string[] {
        const args: string[] = [];
        if (this.options.cluster) {
            args.push("--cluster", this.options.cluster);
        }
        if (this.options.user) {
            args.push("--id", this.options.user);
        }
        return args;
    }

    async isMapped(name: string): Promise<string | null> {    
        try {
            const { stdout, stderr } = await execFile(
                "rbd", [
                    ...this.rbdBaseArgs(),
                    "showmapped",
                    "--format",
                    "json"
                ], { timeout: 30000 }
            );
            if (stderr) console.log(stderr);

            const mappedResult = rbdShowMapped(stdout);

            if (!mappedResult.success){
                throw new Error(`rbd showmapped output validation failed: ${JSON.stringify(mappedResult.errors)}`);
            }

            const entry = mappedResult.data.find(i => i.pool === this.options.pool && i.name === name);

            if (!entry) {
                return null;
            }

            return entry.device;
        }
        catch (error) {
            console.error(error);
            if (error instanceof Error) {
                throw new Error(`rbd showmapped command failed: ${error.message}`);
            } else {
                throw new Error(`rbd showmapped command failed with an unknown error: ${String(error)}`);
            }
        }
    }
    
    async getWatchers(name: string): Promise<RBDWatcher[]> {
        try {
            const { stdout, stderr } = await execFile(
                "rbd", [
                    ...this.rbdBaseArgs(),
                    "status",
                    "--pool",
                    this.options.pool,
                    "--format",
                    "json",
                    name
                ], { timeout: 30000 }
            );
            if (stderr) console.log(stderr);

            const statusResult = rbdStatus(stdout);

            if (!statusResult.success){
                throw new Error(`rbd status output validation failed: ${JSON.stringify(statusResult.errors)}`);
            }

            return statusResult.data.watchers;
        }
        catch (error) {
            console.error(error);
            if (error instanceof Error) {
                throw new Error(`rbd status command failed with code ${(error as any).code}: ${error.message}`);
            } else {
                throw new Error(`rbd status command failed with an unknown error: ${String(error)}`);
            }
        }
    }

    // Polls until the image has no watchers or the wait expires; returns any watchers still present.
    // Watchers from a crashed client linger until the OSD watch timeout (~30s) expires.
    async waitForNoWatchers(name: string, waitMs: number, intervalMs: number = 3000): Promise<RBDWatcher[]> {
        const deadline = Date.now() + waitMs;
        let watchers = await this.getWatchers(name);
        while (watchers.length > 0 && Date.now() < deadline) {
            console.log(`rbd volume ${name} has ${watchers.length} watcher(s); waiting for them to clear`);
            await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
            watchers = await this.getWatchers(name);
        }
        return watchers;
    }

    async map(name: string): Promise<string> {
        try {
            let mappedDevice = await this.isMapped(name);
                
            if (mappedDevice) {
                return mappedDevice;
            }
        } catch {}

        try {
            const { stdout, stderr } = await execFile(
                "rbd", [
                    ...this.rbdBaseArgs(),
                    "map",
                    ...this.options.map_options,
                    "--pool", 
                    this.options.pool,
                    name
                ], { timeout: 30000 }
            );
            if (stderr) console.log(stderr);
    
            return (stdout as string).trim();
        }
        catch (error) {
            console.error(error);
            if (error instanceof Error) {
                // 'code' may not exist on Error, so use (error as any).code
                throw new Error(`rbd map command failed with code ${(error as any).code}: ${error.message}`);
            } else {
                throw new Error(`rbd map command failed with an unknown error: ${String(error)}`);
            }
        }
    }
    
    async unMap(name: string): Promise<void> {
        try {
            let mappedDevice = await this.isMapped(name);
                
            if (!mappedDevice) {
                return;
            }
        } catch {}

        try {
            const { stdout, stderr } = await execFile(
                "rbd", [
                    ...this.rbdBaseArgs(),
                    "unmap",
                    "--pool",
                    this.options.pool,
                    name
                ], { timeout: 30000 }
            );
            if (stderr) console.log(stderr);
            if (stdout) console.log(stdout);

            for(var i = 0; i < 5; i++) {
                if (!(await this.isMapped(name))) {
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
            }
            throw new Error(`${name} is still mapped after unmap`);
        }
        catch (error) {
            console.error(error);
            if (error instanceof Error) {
                throw new Error(`rbd unmap command failed with code ${(error as any).code}: ${error.message}`);
            } else {
                throw new Error(`rbd unmap command failed with an unknown error: ${String(error)}`);
            }
        }
    }

    async list(): Promise<RBDListEntry[]> {
        try {
            const { stdout, stderr } = await execFile(
                "rbd", [
                    ...this.rbdBaseArgs(),
                    "list",
                    "--pool",
                    this.options.pool,
                    "--long",
                    "--format",
                    "json"
                ], { timeout: 30000 }
            );
            if (stderr) console.log(stderr);
            const listResult = rbdList(stdout);
            
            if (!listResult.success){
                throw new Error(`rbd list output validation failed: ${JSON.stringify(listResult.errors)}`);
            }

            return listResult.data;
        }
        catch (error) {
            console.error(error);
            if (error instanceof Error) {
                throw new Error(`rbd list command failed with code ${(error as any).code}: ${error.message}`);
            } else {
                throw new Error(`rbd list command failed with an unknown error: ${String(error)}`);
            }
        }
    }
    
    async getInfo(name: string): Promise<RBDListEntry | undefined> {
        let rbdList = await this.list();
    
        return rbdList.find(i => i.image === name);
    }

    async create(name: string, size: string ): Promise<boolean> {
        try {
            const extraRbdArgs = this.options.rbd_options? [
                "--image-feature", 
                this.options.rbd_options
            ] : []
            const { stdout, stderr } = await execFile(
                "rbd", [
                    ...this.rbdBaseArgs(),
                    "create",
                    "--order",
                    this.options.order,
                    "--pool",
                    this.options.pool,
                    "--size",
                    size,
                    ...extraRbdArgs,
                    name
                ], { timeout: 30000 }
            );
            if (stderr) console.log(stderr);
            if (stdout) console.log(stdout);
            return true;
        }
        catch (error) {
            console.error(error);
            if (error instanceof Error) {
                throw new Error(`rbd create command failed with code ${(error as any).code}: ${error.message}`);
            } else {
                throw new Error(`rbd create command failed with an unknown error: ${String(error)}`);
            }
        }
    }

    async makeFilesystem(fstype: string, device: string, mkfs_options: string ) {
        try {
            const extraArgs = mkfs_options ? ["fs-options", ...mkfs_options.split(' ')] : []
            const { stdout, stderr } = await execFile(
                "mkfs", [
                    "-t",
                    fstype,
                    ...extraArgs,
                    device
                ], { timeout: 120000 }
            );
            if (stderr) console.error(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            if (error instanceof Error) {
                throw new Error(`mkfs -t ${fstype} ${device} command failed with code ${(error as any).code}: ${error.message}`);
            } else {
                throw new Error(`mkfs -t ${fstype} ${device} command failed with an unknown error: ${String(error)}`);
            }
        }
    }

    async remove(name: string): Promise<void> {
        try {
            const { stdout, stderr } = await execFile(
                "rbd", [
                    "trash",
                    "move",
                    "--pool",
                    this.options.pool,
                    name
                ], { timeout: 30000 }
            );
            if (stderr) console.log(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            if (error instanceof Error) {
                throw new Error(`rbd remove command failed with code ${(error as any).code}: ${error.message}`);
            } else {
                throw new Error(`rbd remove command failed with an unknown error: ${String(error)}`);
            }
        }
    }

    // Returns the source device mounted at exactly mountPoint, or null if nothing is mounted there.
    async getMountSource(mountPoint: string): Promise<string | null> {
        try {
            const mounts = await readFile("/proc/mounts", "utf8");
            // Later entries shadow earlier ones at the same mount point
            let source: string | null = null;
            for (const line of mounts.split(/\r?\n/)) {
                const [device, target] = line.split(" ");
                if (target !== undefined && decodeMountField(target) === mountPoint) {
                    source = decodeMountField(device);
                }
            }
            return source;
        } catch(error) {
            console.error(error);
            if (error instanceof Error) {
                throw new Error(`reading /proc/mounts failed with code ${(error as any).code}: ${error.message}`);
            } else {
                throw new Error(`reading /proc/mounts failed with an unknown error: ${String(error)}`);
            }
        }
    }

    async isMounted(mountPoint: string): Promise<boolean> {
        return (await this.getMountSource(mountPoint)) !== null;
    }

    // A mount is healthy only if it is backed by the device this image is currently mapped to;
    // otherwise it is left over from a device that was unmapped (e.g. force-unmapped) underneath us.
    async getMountState(name: string, mountPoint: string): Promise<MountState> {
        const source = await this.getMountSource(mountPoint);
        if (source === null) {
            return "unmounted";
        }
        const device = await this.isMapped(name);
        if (device && await resolveDevice(device) === await resolveDevice(source)) {
            return "healthy";
        }
        return "stale";
    }

    async mount(device: string, mountPoint: string): Promise<void> {
        try {
            await this.unmount(mountPoint, false);
        } catch {}
        await mkdir(mountPoint, { recursive: true });
        try {
            const { stdout, stderr } = await execFile(
                "mount", [
                    device,
                    mountPoint
                ], { timeout: 30000 }
            );
            if (stderr) console.error(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            if (error instanceof Error) {
                throw new Error(`mount command failed with code ${(error as any).code}: ${error.message}`);
            } else {
                throw new Error(`mount command failed with an unknown error: ${String(error)}`);
            }
        }
    }

    async unmount(mountPoint: string, logException: boolean=true, lazy: boolean=false): Promise<void> {
        try {
            const { stdout, stderr } = await execFile(
                "umount", [
                    ...(lazy ? ["--lazy"] : []),
                    mountPoint
                ], { timeout: 30000 }
            );
            if (stderr) console.error(stderr);
            if (stdout) console.log(stdout);
            let unmounted = false;
            for(var i = 0; i < 5; i++) {
                if (!(await this.isMounted(mountPoint))) {
                    unmounted = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
            }
            if (!unmounted) {
                throw new Error(`${mountPoint} is still mounted after umount`);
            }
        }
        catch (error) {
            if (logException) {
                console.error(error);
            }
            if (error instanceof Error) {
                throw new Error(`umount command failed with code ${(error as any).code}: ${error.message}`);
            } else {
                throw new Error(`umount command failed with an unknown error: ${String(error)}`);
            }
        }

        await rmdir(mountPoint);
    }
}
