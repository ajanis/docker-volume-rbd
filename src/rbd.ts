import util from 'util';
import child_process from "child_process";
const execFile = util.promisify(child_process.execFile);
import fs from "fs";

export default class Rbd {
    // ToDo: Actually used the passed in options for cluster and user
    constructor(readonly options: { pool: string, cluster: string, user: string, map_options: string[], order: string, rbd_options: string }) { }

    async isMapped(name: string): Promise<string> {
        let mapped: any[];
    
        try {
            const { stdout, stderr } = await execFile("rbd", ["showmapped", "--format", "json"], { timeout: 30000 });
            if (stderr) console.log(stderr);
    
            mapped = JSON.parse(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`rbd showmapped command failed with code ${error.code}: ${error.message}`);
        }
    
        const entry = mapped.find(i => i.pool === this.options.pool && i.name === name);

        if (!entry) {
            return null;
        }

        return entry.device;
    }
    
    async map(name: string): Promise<string> {
        try {
            const { stdout, stderr } = await execFile("rbd", ["map", ...this.options.map_options, "--pool", this.options.pool, name], { timeout: 30000 });
            if (stderr) console.log(stderr);
    
            return (stdout as string).trim();
        }
        catch (error) {
            console.error(error);
            throw new Error(`rbd map command failed with code ${error.code}: ${error.message}`);
        }
    }
    
    async unMap(name: string): Promise<void> {
        let mustUnmap = await this.isMapped(name);
    
        if (mustUnmap) {
            try {
                const { stdout, stderr } = await execFile("rbd", ["unmap", "--pool", this.options.pool, name], { timeout: 30000 });
                if (stderr) console.log(stderr);
                if (stdout) console.log(stdout);
            }
            catch (error) {
                console.error(error);
                throw new Error(`rbd unmap command failed with code ${error.code}: ${error.message}`);
            }
        }
    }

    async list(): Promise<{ image: string, id: string, size: number, format: number }[]> {
        try {
            const { stdout, stderr } = await execFile("rbd", ["list", "--pool", this.options.pool, "--long", "--format", "json"], { timeout: 30000 });
            if (stderr) console.log(stderr);
            
            return JSON.parse(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`rbd list command failed with code ${error.code}: ${error.message}`);
        }
    }
    
    async getInfo(name: string): Promise<{ image: string, id: string, size: number, format: number }> {
        let rbdList = await this.list();
    
        return rbdList.find(i => i.image === name);
    }

    async create(name: string, size: string ): Promise<void> {
        try {
            const extraRbdArgs = this.options.rbd_options? ["--image-feature", this.options.rbd_options] : []
            const { stdout, stderr } = await execFile("rbd", ["create", "--order", this.options.order, "--pool", this.options.pool, "--size", size, ...extraRbdArgs, name], { timeout: 30000 });
            if (stderr) console.log(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`rbd create command failed with code ${error.code}: ${error.message}`);
        }
    }

    async makeFilesystem(fstype: string, device: string, mkfs_options: string ) {
        try {
            const extraArgs = mkfs_options? ["fs-options", ...mkfs_options.split(' ')] : []
            const { stdout, stderr } = await execFile("mkfs", ["-t", fstype, ...extraArgs, device], { timeout: 120000 });
            if (stderr) console.error(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            throw Error(`mkfs -t ${fstype} ${device} command failed with code ${error.code}: ${error.message}`);
        }
    }

    async remove(name: string): Promise<void> {
        try {
            const { stdout, stderr } = await execFile("rbd", ["trash", "move", "--pool", this.options.pool, name], { timeout: 30000 });
            if (stderr) console.log(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`rbd remove command failed with code ${error.code}: ${error.message}`);
        }
    }

    async mount(device: string, mountPoint: string): Promise<void> {
        fs.mkdirSync(mountPoint, { recursive: true });

        try {
            const { stdout, stderr } = await execFile("mount", [device, mountPoint], { timeout: 30000 });
            if (stderr) console.error(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`mount command failed with code ${error.code}: ${error.message}`);
        }
    }

    async unmount(mountPoint: string): Promise<void> {
        try {
            const { stdout, stderr } = await execFile("umount", [mountPoint], { timeout: 30000 });
            if (stderr) console.error(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`umount command failed with code ${error.code}: ${error.message}`);
        }

        fs.rmdirSync(mountPoint);
    }
}