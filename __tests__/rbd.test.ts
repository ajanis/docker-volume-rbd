import type RbdType from '../src/rbd';

type ExecCall = { stdout?: string; stderr?: string; error?: Error };

// procMounts: successive /proc/mounts contents; the last one repeats once exhausted
async function loadRbdWithMock(execSequence: ExecCall[], procMounts: string[] = ['']) {
  // Fresh module instance each time
  jest.resetModules();

  jest.doMock('fs/promises', () => {
    const actual = jest.requireActual('fs/promises');
    return {
      ...actual,
      readFile: jest.fn(async () => (procMounts.length > 1 ? procMounts.shift() : procMounts[0])),
      realpath: jest.fn(async (p: string) => p),
      rmdir: jest.fn(async () => undefined),
    };
  });

  const execMock = jest.fn(async () => {
    const call = execSequence.shift();
    if (!call) {
      throw new Error('execFile called too many times');
    }
    if (call.error) throw call.error;
    return { stdout: call.stdout ?? '', stderr: call.stderr ?? '' };
  });

  jest.doMock('util', () => {
    const actual = jest.requireActual('util');
    return { ...actual, promisify: () => execMock };
  });

  const mod = await import('../src/rbd');
  const Rbd = mod.default as typeof RbdType;
  return { Rbd, execMock };
}

const baseOptions = {
  pool: 'rbd',
  cluster: 'ceph',
  user: 'client.test',
  map_options: ['--exclusive'],
  order: '22',
  rbd_options: 'layering',
};

describe('Rbd command helpers', () => {
  test('isMapped finds device from keyed JSON', async () => {
    const { Rbd, execMock } = await loadRbdWithMock([
      {
        stdout: JSON.stringify([
          { id: '1', pool: 'rbd', namespace: '', name: 'vol1', snap: '-', device: '/dev/rbd1' },
          { id: '2', pool: 'other', namespace: '', name: 'vol2', snap: '-', device: '/dev/rbd2' },
        ]),
      },
    ]);

    const rbd = new Rbd(baseOptions);
    const device = await rbd.isMapped('vol1');

    expect(device).toBe('/dev/rbd1');
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  test('isMapped returns null when not found', async () => {
    const { Rbd } = await loadRbdWithMock([{ stdout: JSON.stringify([]) }]);
    const rbd = new Rbd(baseOptions);
    const device = await rbd.isMapped('missing');
    expect(device).toBeNull();
  });

  test('getWatchers returns watchers from rbd status', async () => {
    const watchers = [{ address: '10.0.0.5:0/123456', client: 4567, cookie: 140385432123456 }];
    const { Rbd, execMock } = await loadRbdWithMock([{ stdout: JSON.stringify({ watchers }) }]);

    const rbd = new Rbd(baseOptions);
    const res = await rbd.getWatchers('vol1');

    expect(res).toEqual(watchers);
    const args = ((execMock.mock.calls[0] as any)?.[1] ?? []) as string[];
    expect(args).toEqual(['--cluster', 'ceph', '--id', 'client.test', 'status', '--pool', 'rbd', '--format', 'json', 'vol1']);
  });

  test('getWatchers returns empty array when no watchers', async () => {
    const { Rbd } = await loadRbdWithMock([{ stdout: JSON.stringify({ watchers: [] }) }]);
    const rbd = new Rbd(baseOptions);
    expect(await rbd.getWatchers('vol1')).toEqual([]);
  });

  test('getWatchers throws when rbd status fails', async () => {
    const { Rbd } = await loadRbdWithMock([{ error: new Error('image not found') }]);
    const rbd = new Rbd(baseOptions);
    await expect(rbd.getWatchers('missing')).rejects.toThrow('rbd status command failed');
  });

  test('waitForNoWatchers returns empty once watchers clear', async () => {
    const watcher = { address: '10.0.0.5:0/123456', client: 4567, cookie: 1 };
    const { Rbd, execMock } = await loadRbdWithMock([
      { stdout: JSON.stringify({ watchers: [watcher] }) },
      { stdout: JSON.stringify({ watchers: [watcher] }) },
      { stdout: JSON.stringify({ watchers: [] }) },
    ]);
    const rbd = new Rbd(baseOptions);

    expect(await rbd.waitForNoWatchers('vol1', 1000, 1)).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(3);
  });

  test('waitForNoWatchers returns remaining watchers after the wait expires', async () => {
    const watcher = { address: '10.0.0.5:0/123456', client: 4567, cookie: 1 };
    const status = { stdout: JSON.stringify({ watchers: [watcher] }) };
    const { Rbd } = await loadRbdWithMock(Array.from({ length: 50 }, () => ({ ...status })));
    const rbd = new Rbd(baseOptions);

    expect(await rbd.waitForNoWatchers('vol1', 30, 10)).toEqual([watcher]);
  });

  test('waitForNoWatchers checks once when wait is zero', async () => {
    const watcher = { address: '10.0.0.5:0/123456', client: 4567, cookie: 1 };
    const { Rbd, execMock } = await loadRbdWithMock([{ stdout: JSON.stringify({ watchers: [watcher] }) }]);
    const rbd = new Rbd(baseOptions);

    expect(await rbd.waitForNoWatchers('vol1', 0)).toEqual([watcher]);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  const mapped = (name: string, device: string) => ({
    stdout: JSON.stringify([{ id: '0', pool: 'rbd', namespace: '', name, snap: '-', device }]),
  });
  const notMapped = { stdout: JSON.stringify([]) };
  const mountLine = (device: string, target: string) => `${device} ${target} xfs rw,relatime 0 0`;

  test('getMountSource matches the mount point exactly, not by prefix', async () => {
    const { Rbd } = await loadRbdWithMock([], [mountLine('/dev/rbd1', '/mnt/volumes/rbd/app-data')]);
    const rbd = new Rbd(baseOptions);

    expect(await rbd.getMountSource('/mnt/volumes/rbd/app')).toBeNull();
    expect(await rbd.getMountSource('/mnt/volumes/rbd/app-data')).toBe('/dev/rbd1');
  });

  test('getMountSource decodes octal escapes and uses the topmost mount', async () => {
    const mounts = [
      mountLine('/dev/rbd1', '/mnt/my\\040vol'),
      mountLine('/dev/rbd2', '/mnt/my\\040vol'),
    ].join('\n');
    const { Rbd } = await loadRbdWithMock([], [mounts]);
    const rbd = new Rbd(baseOptions);

    expect(await rbd.getMountSource('/mnt/my vol')).toBe('/dev/rbd2');
  });

  test('getMountState is healthy when mounted from the current mapping', async () => {
    const { Rbd } = await loadRbdWithMock([mapped('vol1', '/dev/rbd0')], [mountLine('/dev/rbd0', '/mnt/volumes/rbd/vol1')]);
    const rbd = new Rbd(baseOptions);
    expect(await rbd.getMountState('vol1', '/mnt/volumes/rbd/vol1')).toBe('healthy');
  });

  test('getMountState is stale when the image is no longer mapped', async () => {
    const { Rbd } = await loadRbdWithMock([notMapped], [mountLine('/dev/rbd0', '/mnt/volumes/rbd/vol1')]);
    const rbd = new Rbd(baseOptions);
    expect(await rbd.getMountState('vol1', '/mnt/volumes/rbd/vol1')).toBe('stale');
  });

  test('getMountState is stale when mounted from a different device', async () => {
    const { Rbd } = await loadRbdWithMock([mapped('vol1', '/dev/rbd3')], [mountLine('/dev/rbd0', '/mnt/volumes/rbd/vol1')]);
    const rbd = new Rbd(baseOptions);
    expect(await rbd.getMountState('vol1', '/mnt/volumes/rbd/vol1')).toBe('stale');
  });

  test('getMountState is unmounted without checking the mapping', async () => {
    const { Rbd, execMock } = await loadRbdWithMock([], ['']);
    const rbd = new Rbd(baseOptions);
    expect(await rbd.getMountState('vol1', '/mnt/volumes/rbd/vol1')).toBe('unmounted');
    expect(execMock).not.toHaveBeenCalled();
  });

  test('unmount passes --lazy when requested', async () => {
    const { Rbd, execMock } = await loadRbdWithMock([{ stdout: '' }], ['']);
    const rbd = new Rbd(baseOptions, 1);

    await rbd.unmount('/mnt/volumes/rbd/vol1', true, true);

    expect((execMock.mock.calls[0] as any)[1]).toEqual(['--lazy', '/mnt/volumes/rbd/vol1']);
  });

  test('unmount throws when the mount point is still mounted', async () => {
    const { Rbd } = await loadRbdWithMock([{ stdout: '' }], [mountLine('/dev/rbd0', '/mnt/volumes/rbd/vol1')]);
    const rbd = new Rbd(baseOptions, 1);

    await expect(rbd.unmount('/mnt/volumes/rbd/vol1', false)).rejects.toThrow('still mounted');
  });

  test('unMap throws when the image is still mapped', async () => {
    const still = mapped('vol1', '/dev/rbd0');
    const { Rbd } = await loadRbdWithMock([still, { stdout: '' }, still, still, still, still, still]);
    const rbd = new Rbd(baseOptions, 1);

    await expect(rbd.unMap('vol1')).rejects.toThrow('still mapped');
  });

  test('unMap succeeds once the image is gone', async () => {
    const { Rbd } = await loadRbdWithMock([mapped('vol1', '/dev/rbd0'), { stdout: '' }, mapped('vol1', '/dev/rbd0'), notMapped]);
    const rbd = new Rbd(baseOptions, 1);

    await expect(rbd.unMap('vol1')).resolves.toBeUndefined();
  });

  test('list parses array JSON output', async () => {
    const list = [{ image: 'vol1', id: '1', size: 2048, format: 2 }];
    const { Rbd, execMock } = await loadRbdWithMock([{ stdout: JSON.stringify(list) }]);

    const rbd = new Rbd(baseOptions);
    const res = await rbd.list();

    expect(res).toEqual(list);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  test('makeFilesystem forwards options verbatim', async () => {
    const { Rbd, execMock } = await loadRbdWithMock([{ stdout: '' }]);
    const rbd = new Rbd(baseOptions);

    await rbd.makeFilesystem('xfs', '/dev/rbd1', '-m crc=1 -n ftype=1');

    expect(execMock).toHaveBeenCalledTimes(1);
    const firstCall = execMock.mock.calls[0] as any;
    const args = (firstCall?.[1] ?? []) as string[];
    expect(args).toEqual(['-t', 'xfs', 'fs-options', '-m', 'crc=1', '-n', 'ftype=1', '/dev/rbd1']);
  });
});

